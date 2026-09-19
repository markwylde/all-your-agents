#!/usr/bin/env python3
"""Run interactive `omp` on a PTY with its first prompt as an argument, until told to stop.

omp records the terminal a session runs on, and only a process with a terminal is a live
session. `script` would do, but it forwards EOF from a closed stdin and omp quits on it.
"""

from __future__ import annotations

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def main() -> int:
	master, slave = pty.openpty()
	winsize = struct.pack("HHHH", 40, 120, 0, 0)
	fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
	fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)
	pid = os.fork()
	if pid == 0:
		os.close(master)
		os.setsid()
		fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
		os.dup2(slave, 0)
		os.dup2(slave, 1)
		os.dup2(slave, 2)
		if slave > 2:
			os.close(slave)
		os.execvp("omp", ["omp", *sys.argv[1:]])
	os.close(slave)

	def stop(_signum: int, _frame: object) -> None:
		# omp removes its presence file and records `session_exit` on a clean signal.
		try:
			os.kill(pid, signal.SIGTERM)
		except ProcessLookupError:
			pass

	signal.signal(signal.SIGTERM, stop)
	signal.signal(signal.SIGINT, stop)
	print(f"PID {pid}", flush=True)
	while True:
		try:
			ready, _, _ = select.select([master], [], [], 0.5)
			if ready and not os.read(master, 8192):
				break
		except OSError:
			break
		done, _ = os.waitpid(pid, os.WNOHANG)
		if done:
			return 0
	os.waitpid(pid, 0)
	return 0


if __name__ == "__main__":
	sys.exit(main())
