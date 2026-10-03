## 1. One holder per session id

- [x] 1.1 `bind`: when another live process holds the session id, the later-started process holds it and the other waits; verify a resume moves the session, both present at start bind the later one, and a waiting file's rewrite changes nothing
- [x] 1.2 `teardown`: service waiting files for the id when its holder goes away; verify the first process exiting leaves the resumed session live, and the first takes the session back when the second exits
- [x] 1.3 Forget a waiting file when it is removed, unreadable or invalid; verify a removed waiting file is not serviced when the holder exits

## 2. Verification

- [x] 2.1 `npm run lint` and `npm test` pass
