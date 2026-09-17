#!/usr/bin/env python3
"""Drive `claude --resume` over a PTY: dismiss onboarding, pick a session, type a prompt."""

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


def compact(text: str) -> str:
	text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
	text = re.sub(r"\x1b\].*?(?:\x07|\x1b\\)", "", text)
	return re.sub(r"\s+", "", text).lower()


def main() -> int:
	print("READY", flush=True)
	prompt = sys.argv[1] if len(sys.argv) > 1 else "Reply with only the word PICKED then stop."
	master, slave = pty.openpty()
	winsize = struct.pack("HHHH", 40, 120, 0, 0)
	fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
	fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)
	pid = os.fork()
	if pid == 0:
		os.close(master)
		os.dup2(slave, 0)
		os.dup2(slave, 1)
		os.dup2(slave, 2)
		if slave > 2:
			os.close(slave)
		os.execvp("claude", ["claude", "--resume", "--dangerously-skip-permissions"])
	os.close(slave)

	buf = b""
	sent_theme = False
	sent_security = False
	sent_trust = False
	sent_pick = False
	theme_at = 0.0
	deadline = time.time() + 30

	def read_more(timeout: float) -> None:
		nonlocal buf
		end = time.time() + timeout
		while time.time() < end:
			ready, _, _ = select.select([master], [], [], max(0.0, end - time.time()))
			if not ready:
				break
			try:
				chunk = os.read(master, 8192)
			except OSError:
				return
			if not chunk:
				return
			buf += chunk

	try:
		while time.time() < deadline:
			read_more(0.25)
			blob = compact(buf.decode("utf-8", "replace"))
			if not sent_theme and (
				"choosethetextstyle" in blob or ("darkmode" in blob and "welcome" in blob)
			):
				os.write(master, b"\r")
				sent_theme = True
				theme_at = time.time()
				print("THEME", flush=True)
				time.sleep(0.4)
				continue
			if sent_theme and not sent_security and "pressentertocontinue" in blob:
				os.write(master, b"\r")
				sent_security = True
				print("SECURITY", flush=True)
				time.sleep(0.4)
				continue
			if sent_theme and not sent_trust and "itrustthisfolder" in blob:
				# Two stacked choices; default is "No, exit". Down selects Yes.
				os.write(master, b"\x1b[B")
				time.sleep(0.4)
				read_more(0.4)
				moved = compact(buf.decode("utf-8", "replace"))
				print("TRUST_AFTER_DOWN", moved[-220:], flush=True)
				os.write(master, b"\r")
				sent_trust = True
				print("TRUST", flush=True)
				time.sleep(0.6)
				continue
			if sent_theme and sent_trust and not sent_pick and (
				"resume" in blob
				or "recent" in blob
				or time.time() - theme_at > 6
			):
				print("AFTER_THEME", blob[-400:], flush=True)
				try:
					os.write(master, b"\x1b[B")
					time.sleep(0.12)
					os.write(master, b"\x1b[A")
					time.sleep(0.12)
					os.write(master, b"\r")
				except OSError as err:
					print(f"PICK_FAIL {err}", flush=True)
					return 2
				sent_pick = True
				print("PICKED", flush=True)
				time.sleep(0.5)
				continue
			if sent_pick:
				while time.time() < deadline + 40:
					read_more(0.5)
					if os.waitpid(pid, os.WNOHANG)[0]:
						return 0
				break
		return 0 if sent_pick else 2
	finally:
		try:
			os.write(master, b"\x03")
		except OSError:
			pass
		time.sleep(0.2)
		try:
			os.kill(pid, signal.SIGKILL)
		except OSError:
			pass
		try:
			os.waitpid(pid, 0)
		except OSError:
			pass


if __name__ == "__main__":
	sys.exit(main())
