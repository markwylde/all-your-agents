#!/usr/bin/env python3
"""Drive `claude --resume` over a PTY: wait for a session to be listed, then pick it.

Onboarding and folder trust must already be done in `$CLAUDE_CONFIG_DIR`, so the first
screen is the picker. Rows show a generated title, so the session counts as listed once
the selected row of the `--bg` seed (`❯ <title> <age> · bg · ...`) is drawn. Prints
LISTED then, PICKED once Enter is pressed on it, and SCREEN with what it saw on the way
out. Keeps `claude` running until SIGTERM.
"""

from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

LIST_TIMEOUT_S = 15
SELECTED_ROW = re.compile(r"❯.+?·bg·")


def compact(text: str) -> str:
	text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
	text = re.sub(r"\x1b\].*?(?:\x07|\x1b\\)", "", text)
	return re.sub(r"\s+", "", text).lower()


def main() -> int:
	pid, master = pty.fork()
	if pid == 0:
		os.execvp("claude", ["claude", "--resume", "--dangerously-skip-permissions"])
	fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

	def stop(_signum: int, _frame: object) -> None:
		raise SystemExit(0)

	signal.signal(signal.SIGTERM, stop)
	buf = b""

	def read_for(seconds: float) -> None:
		nonlocal buf
		end = time.time() + seconds
		while (left := end - time.time()) > 0:
			ready, _, _ = select.select([master], [], [], left)
			if not ready:
				return
			try:
				chunk = os.read(master, 8192)
			except OSError:
				return
			if not chunk:
				return
			buf += chunk

	def screen() -> str:
		return compact(buf.decode("utf-8", "replace"))

	try:
		deadline = time.time() + LIST_TIMEOUT_S
		while not SELECTED_ROW.search(screen()):
			if time.time() > deadline:
				return 2
			read_for(0.2)
		print("LISTED", flush=True)
		# Let the picker finish drawing; keys sent mid-render land in its search box.
		settled = len(buf)
		while True:
			read_for(0.3)
			if len(buf) == settled:
				break
			settled = len(buf)
		os.write(master, b"\r")
		print("PICKED", flush=True)
		while True:
			read_for(1)
			if os.waitpid(pid, os.WNOHANG)[0]:
				print("EXITED", flush=True)
				return 1
	finally:
		print(f"SCREEN {screen()[-800:]}", flush=True)
		try:
			os.kill(pid, signal.SIGKILL)
			os.waitpid(pid, 0)
		except OSError:
			pass


if __name__ == "__main__":
	sys.exit(main())
