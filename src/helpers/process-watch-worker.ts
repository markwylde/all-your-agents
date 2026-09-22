import { platform } from 'node:os';
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
	throw new Error('must run as worker');
}

const port = parentPort;
const early: unknown[] = [];
let handler: ((msg: { type: string; pid?: number }) => void) | undefined;
port.on('message', (msg: { type: string; pid?: number }) => {
	if (handler) handler(msg);
	else early.push(msg);
});

function onMessage(fn: (msg: { type: string; pid?: number }) => void): void {
	handler = fn;
	for (const msg of early) fn(msg as { type: string; pid?: number });
	early.length = 0;
}

async function main(): Promise<void> {
	let koffi: typeof import('koffi');
	try {
		koffi = (await import('koffi')).default;
	} catch (err) {
		port.postMessage({ type: 'unsupported', error: String(err) });
		port.close();
		return;
	}
	try {
		if (platform() === 'darwin') runDarwin(koffi);
		else if (platform() === 'linux') runLinux(koffi);
		else {
			port.postMessage({ type: 'unsupported', error: `platform ${platform()}` });
			port.close();
		}
	} catch (err) {
		port.postMessage({ type: 'unsupported', error: String(err) });
		port.close();
	}
}

function encodeKevent(ev: {
	ident: number;
	filter: number;
	flags: number;
	fflags: number;
}): Buffer {
	const buf = Buffer.alloc(32);
	buf.writeBigUInt64LE(BigInt(ev.ident >>> 0), 0);
	buf.writeInt16LE(ev.filter, 8);
	buf.writeUInt16LE(ev.flags, 10);
	buf.writeUInt32LE(ev.fflags >>> 0, 12);
	return buf;
}

function decodeKevent(
	buf: Buffer,
	index: number,
): {
	ident: number;
	filter: number;
	flags: number;
} {
	const o = index * 32;
	return {
		ident: Number(buf.readBigUInt64LE(o)),
		filter: buf.readInt16LE(o + 8),
		flags: buf.readUInt16LE(o + 10),
	};
}

function runDarwin(koffi: typeof import('koffi')): void {
	const EVFILT_READ = -1;
	const EVFILT_PROC = -5;
	const EV_ADD = 0x0001;
	const EV_DELETE = 0x0002;
	const EV_ONESHOT = 0x0010;
	const EV_ERROR = 0x4000;
	const NOTE_EXIT = 0x80000000;

	const lib = koffi.load('libSystem.B.dylib');
	const kqueue = lib.func('int kqueue()');
	const kevent = lib.func(
		'int kevent(int kq, const void *changelist, int nchanges, void *eventlist, int nevents, const void *timeout)',
	);
	const pipeFn = lib.func('int pipe(_Out_ int *fds)');
	const readFn = lib.func('int64_t read(int fd, void *buf, size_t n)');
	const writeFn = lib.func('int64_t write(int fd, const void *buf, size_t n)');
	const closeFn = lib.func('int close(int fd)');

	const kq = kqueue();
	if (kq < 0) throw new Error('kqueue');
	const fds = [0, 0];
	if (pipeFn(fds) !== 0) throw new Error('pipe');
	const rfd = fds[0] ?? 0;
	const wfd = fds[1] ?? 0;

	const addPipe = encodeKevent({ ident: rfd, filter: EVFILT_READ, flags: EV_ADD, fflags: 0 });
	if (kevent(kq, addPipe, 1, null, 0, null) < 0) throw new Error('kevent add pipe');

	const pending = new Map<number, 'add' | 'remove'>();
	let running = true;
	let open = true;
	const zeroTimeout = Buffer.alloc(16);

	const apply = (): void => {
		for (const [pid, op] of pending) {
			const change = encodeKevent({
				ident: pid,
				filter: EVFILT_PROC,
				flags: op === 'add' ? EV_ADD | EV_ONESHOT : EV_DELETE,
				fflags: NOTE_EXIT,
			});
			const events = Buffer.alloc(32);
			const n = kevent(kq, change, 1, events, 1, zeroTimeout);
			if (n > 0) {
				const ev = decodeKevent(events, 0);
				if (ev.flags & EV_ERROR) port.postMessage({ type: 'exit', pid, reason: 'kevent' });
			}
		}
		pending.clear();
	};

	onMessage((msg) => {
		if (msg.type === 'watch' && msg.pid != null) pending.set(msg.pid, 'add');
		else if (msg.type === 'unwatch' && msg.pid != null) pending.set(msg.pid, 'remove');
		else if (msg.type === 'stop') running = false;
		if (open) writeFn(wfd, Buffer.from([1]), 1);
	});

	port.postMessage({ type: 'ready' });

	const eventlist = Buffer.alloc(32 * 8);
	const keventAsync = kevent.async as (
		kq: number,
		changelist: unknown,
		nchanges: number,
		eventlist: Buffer,
		nevents: number,
		timeout: unknown,
		cb: (err: Error | null, n: number) => void,
	) => void;

	const shutdown = (): void => {
		if (!open) return;
		open = false;
		closeFn(rfd);
		closeFn(wfd);
		closeFn(kq);
		setImmediate(() => {
			port.close();
		});
	};

	const loop = (): void => {
		if (!running) {
			shutdown();
			return;
		}
		apply();
		keventAsync(kq, null, 0, eventlist, 8, null, (err, n) => {
			if (!running) {
				shutdown();
				return;
			}
			if (err || n < 0) {
				port.postMessage({ type: 'unsupported', error: `wait ${err ?? n}` });
				shutdown();
				return;
			}
			for (let i = 0; i < n; i++) {
				const ev = decodeKevent(eventlist, i);
				if (ev.filter === EVFILT_READ && ev.ident === rfd) {
					readFn(rfd, Buffer.alloc(8), 8);
					continue;
				}
				if (ev.filter === EVFILT_PROC || ev.flags & EV_ERROR) {
					port.postMessage({ type: 'exit', pid: ev.ident, reason: 'event' });
				}
			}
			loop();
		});
	};
	loop();
}

function runLinux(koffi: typeof import('koffi')): void {
	const EPOLLIN = 0x001;
	const EPOLL_CTL_ADD = 1;
	const EPOLL_CTL_DEL = 2;
	const SYS_pidfd_open = process.arch === 'arm64' ? 438 : 434;

	const lib = koffi.load('libc.so.6');
	const syscall = lib.func('long syscall(long n, ...)');
	let pidfdOpen: (pid: number, flags: number) => number;
	try {
		pidfdOpen = lib.func('int pidfd_open(int pid, unsigned int flags)');
	} catch {
		pidfdOpen = (pid, flags) => {
			const fd = Number(syscall(SYS_pidfd_open, pid, flags));
			return !Number.isFinite(fd) || fd > 0x7fffffff ? -1 : fd;
		};
	}
	const epollCreate1 = lib.func('int epoll_create1(int flags)');
	const epollCtl = lib.func('int epoll_ctl(int epfd, int op, int fd, void *event)');
	const epollWait = lib.func('int epoll_wait(int epfd, void *events, int maxevents, int timeout)');
	const pipeFn = lib.func('int pipe(_Out_ int *fds)');
	const readFn = lib.func('int64_t read(int fd, void *buf, size_t n)');
	const writeFn = lib.func('int64_t write(int fd, const void *buf, size_t n)');
	const closeFn = lib.func('int close(int fd)');

	// x86_64 packs epoll_event to 12 bytes (data at offset 4). Other arches pad to 16.
	const packed = process.arch === 'x64';
	const eventSize = packed ? 12 : 16;
	const dataOffset = packed ? 4 : 8;
	const encodeEpoll = (events: number, data: number): Buffer => {
		const buf = Buffer.alloc(eventSize);
		buf.writeUInt32LE(events, 0);
		buf.writeBigUInt64LE(BigInt(data >>> 0), dataOffset);
		return buf;
	};
	const decodeEpoll = (buf: Buffer, index: number): number => {
		return Number(buf.readBigUInt64LE(index * eventSize + dataOffset));
	};

	const epfd = epollCreate1(0);
	if (epfd < 0) throw new Error('epoll_create1');
	const fds = [0, 0];
	if (pipeFn(fds) !== 0) throw new Error('pipe');
	const rfd = fds[0] ?? 0;
	const wfd = fds[1] ?? 0;
	if (epollCtl(epfd, EPOLL_CTL_ADD, rfd, encodeEpoll(EPOLLIN, rfd)) !== 0) {
		throw new Error('epoll add pipe');
	}

	const pidfds = new Map<number, number>();
	const pending = new Map<number, 'add' | 'remove'>();
	let running = true;
	let open = true;

	const apply = (): void => {
		for (const [pid, op] of pending) {
			if (op === 'remove') {
				const fd = pidfds.get(pid);
				if (fd != null) {
					epollCtl(epfd, EPOLL_CTL_DEL, fd, null);
					closeFn(fd);
					pidfds.delete(pid);
				}
				continue;
			}
			const fd = pidfdOpen(pid, 0);
			if (fd < 0) {
				port.postMessage({ type: 'exit', pid, reason: 'pidfd_open', errno: koffi.errno() });
				continue;
			}
			pidfds.set(pid, fd);
			if (epollCtl(epfd, EPOLL_CTL_ADD, fd, encodeEpoll(EPOLLIN, fd)) !== 0) {
				const errno = koffi.errno();
				closeFn(fd);
				pidfds.delete(pid);
				port.postMessage({ type: 'exit', pid, reason: 'epoll_ctl', errno });
			}
		}
		pending.clear();
	};

	onMessage((msg) => {
		if (msg.type === 'watch' && msg.pid != null) pending.set(msg.pid, 'add');
		else if (msg.type === 'unwatch' && msg.pid != null) pending.set(msg.pid, 'remove');
		else if (msg.type === 'stop') running = false;
		if (open) writeFn(wfd, Buffer.from([1]), 1);
	});

	port.postMessage({ type: 'ready' });

	const events = Buffer.alloc(eventSize * 8);
	const epollWaitAsync = epollWait.async as (
		epfd: number,
		events: Buffer,
		max: number,
		timeout: number,
		cb: (err: Error | null, n: number) => void,
	) => void;

	const shutdown = (): void => {
		if (!open) return;
		open = false;
		for (const fd of pidfds.values()) closeFn(fd);
		closeFn(rfd);
		closeFn(wfd);
		closeFn(epfd);
		setImmediate(() => {
			port.close();
		});
	};

	const loop = (): void => {
		if (!running) {
			shutdown();
			return;
		}
		apply();
		epollWaitAsync(epfd, events, 8, -1, (err, n) => {
			if (!running) {
				shutdown();
				return;
			}
			if (err || n < 0) {
				port.postMessage({ type: 'unsupported', error: `wait ${err ?? n}` });
				shutdown();
				return;
			}
			const lookup = new Map<number, number>();
			for (const [pid, fd] of pidfds) lookup.set(fd, pid);
			for (let i = 0; i < n; i++) {
				const data = decodeEpoll(events, i);
				if (data === rfd) {
					readFn(rfd, Buffer.alloc(8), 8);
					continue;
				}
				const pid = lookup.get(data);
				if (pid != null) {
					const fd = pidfds.get(pid);
					if (fd != null) {
						epollCtl(epfd, EPOLL_CTL_DEL, fd, null);
						closeFn(fd);
						pidfds.delete(pid);
					}
					port.postMessage({ type: 'exit', pid, reason: 'event' });
				}
			}
			loop();
		});
	};
	loop();
}

void main();
