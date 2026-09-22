function runLinux(koffi: typeof import('koffi')): void {
	const POLLIN = 0x0001;
	const POLLERR = 0x0008;
	const POLLHUP = 0x0010;
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
	const pollFn = lib.func('int poll(void *fds, unsigned long nfds, int timeout)');
	const pipeFn = lib.func('int pipe(_Out_ int *fds)');
	const readFn = lib.func('int64_t read(int fd, void *buf, size_t n)');
	const writeFn = lib.func('int64_t write(int fd, const void *buf, size_t n)');
	const closeFn = lib.func('int close(int fd)');
	const fds = [0, 0];
	if (pipeFn(fds) !== 0) throw new Error('pipe');
	const rfd = fds[0] ?? 0;
	const wfd = fds[1] ?? 0;
	const pidfds = new Map<number, number>();
	const pending = new Map<number, 'add' | 'remove'>();
	let running = true;
	let open = true;
	const apply = (): void => {
		for (const [pid, op] of pending) {
			if (op === 'remove') {
				const fd = pidfds.get(pid);
				if (fd != null) {
					closeFn(fd);
					pidfds.delete(pid);
				}
				continue;
			}
			const fd = pidfdOpen(pid, 0);
			if (fd < 0) {
				port.postMessage({ type: 'exit', pid });
				continue;
			}
			pidfds.set(pid, fd);
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
	const pollfdSize = 8;
	const pollAsync = pollFn.async as (
		fds: Buffer,
		nfds: number,
		timeout: number,
		cb: (err: Error | null, n: number) => void,
	) => void;
	const shutdown = (): void => {
		if (!open) return;
		open = false;
		for (const fd of pidfds.values()) closeFn(fd);
		closeFn(rfd);
		closeFn(wfd);
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
		const pollfds = Buffer.alloc((pidfds.size + 1) * pollfdSize);
		pollfds.writeInt32LE(rfd, 0);
		pollfds.writeInt16LE(POLLIN, 4);
		let index = 1;
		for (const fd of pidfds.values()) {
			const offset = index * pollfdSize;
			pollfds.writeInt32LE(fd, offset);
			pollfds.writeInt16LE(POLLIN, offset + 4);
			index++;
		}
		pollAsync(pollfds, pidfds.size + 1, -1, (err, n) => {
			if (!running) {
				shutdown();
				return;
			}
			if (err || n < 0) {
				port.postMessage({ type: 'unsupported' });
				shutdown();
				return;
			}
			const rfdRevents = pollfds.readInt16LE(6);
			if (rfdRevents !== 0) readFn(rfd, Buffer.alloc(8), 8);
			index = 1;
			for (const [pid, fd] of [...pidfds]) {
				const revents = pollfds.readInt16LE(index * pollfdSize + 6);
				index++;
				if ((revents & (POLLIN | POLLERR | POLLHUP)) === 0) continue;
				closeFn(fd);
				pidfds.delete(pid);
				port.postMessage({ type: 'exit', pid });
			}
			loop();
		});
	};
	loop();
}
void main();
