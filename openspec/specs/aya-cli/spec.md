# aya-cli Specification

## Purpose

The `all-your-agents` command: a `top`/`htop`-style terminal monitor that shows the live status of every coding-agent session on the machine, built on the public all-your-agents API.

## Requirements

### Requirement: Executable
The package SHALL install an executable named `aya` that runs on Node ≥ 20 on macOS and Linux. It SHALL accept `--once`, `--json`, `--all`, `--help`, and `--version`. An unknown flag SHALL print usage to stderr and exit with status 2. The command SHALL add no runtime dependencies to the package.

#### Scenario: Help
- **WHEN** the user runs `aya --help`
- **THEN** usage listing every flag and key binding is printed to stdout and the process exits 0

#### Scenario: Unknown flag
- **WHEN** the user runs `aya --bogus`
- **THEN** usage is printed to stderr and the process exits 2

#### Scenario: Installed from tarball
- **WHEN** the packed tarball is installed into a fresh project and `npx aya --version` runs
- **THEN** it prints the package version and exits 0

### Requirement: Live session table
In interactive mode `aya` SHALL take over the terminal (alternate screen, hidden cursor) and show one row per live session. Each row SHALL show status, harness, pid, title, cwd, model, current tool name, open subagent count, last turn outcome, and last-updated time. A header SHALL show the total number of live sessions and the count per status (`running`, `waiting`, `idle`). Values that are unknown SHALL render as `-`. Rows SHALL be truncated to the terminal width, never wrapped.

#### Scenario: Sessions already live
- **WHEN** two sessions are live before `aya` starts, one `running` and one `idle`
- **THEN** after catch-up the table shows both rows and the header shows `2` live, `1` running, `0` waiting, `1` idle

#### Scenario: Before ready
- **WHEN** catch-up has not finished
- **THEN** the screen indicates it is loading and does not show a partial count as final

#### Scenario: Narrow terminal
- **WHEN** the terminal is narrower than the full row
- **THEN** lower-priority columns are dropped or truncated and no line exceeds the terminal width

### Requirement: Live updates
The table SHALL reflect `session:create`, `session:open`, `session:status`, `session:update`, `session:activity`, `session:close`, `subagent:start`, and `subagent:end` as they arrive. A closed session SHALL leave the table unless closed sessions are shown.

#### Scenario: New agent starts
- **WHEN** a new session is created while `aya` is open
- **THEN** a row for it appears without any user input

#### Scenario: Status change
- **WHEN** a live session goes from `running` to `waiting`
- **THEN** its row and the header counts update

#### Scenario: Agent exits
- **WHEN** a live session closes and closed sessions are hidden
- **THEN** its row is removed and the header counts update

### Requirement: Event-driven redraw
`aya` SHALL follow ADR 0001. It SHALL redraw only in response to a library event, a keypress, or a terminal resize, and SHALL coalesce bursts of events into at most one redraw per event-loop turn. It SHALL NOT use a timer to refresh the screen or re-query sessions. Times SHALL be shown as absolute wall-clock times rather than durations that would need to tick.

#### Scenario: Idle screen holds no timers
- **WHEN** `aya` is open and no session, key, or terminal size changes
- **THEN** no redraw happens and no `setTimeout` or `setInterval` is pending

#### Scenario: Burst of events
- **WHEN** ten events arrive in the same event-loop turn
- **THEN** the screen is written once

#### Scenario: Resize
- **WHEN** the terminal is resized
- **THEN** the screen redraws to the new dimensions

### Requirement: Selection and detail
The user SHALL be able to move a selection through rows with `↑`/`↓` and `k`/`j`, jump with `Home`/`End` and `PgUp`/`PgDn`, and toggle a detail view for the selected session with `Enter`. The detail view SHALL show the session id, full title, full cwd, kind, `waitingFor` when set, the current tool with its start time, the last error when set, and the session's subagents with type, title, status, and background flag. The selection SHALL stay on the same session across updates and re-sorts; if that session leaves the table, the selection SHALL move to the nearest remaining row.

#### Scenario: Selection follows session
- **WHEN** the selected session moves to a different row because of a sort or another row being added
- **THEN** the same session remains selected

#### Scenario: Detail shows subagents
- **WHEN** the user presses `Enter` on a session with two subagents, one running and one completed
- **THEN** the detail view lists both with their status

#### Scenario: Selected session closes
- **WHEN** the selected session closes and closed sessions are hidden
- **THEN** the selection moves to the nearest remaining row

### Requirement: Sorting
The table SHALL be sorted by status by default (`waiting`, then `running`, then `idle`, then unknown), then by last-updated time, newest first. The user SHALL be able to cycle the sort column with `s` (or `<`/`>`) and reverse it with `r`. The active sort column SHALL be marked in the column header.

#### Scenario: Default order
- **WHEN** sessions with statuses `idle`, `waiting`, and `running` are live
- **THEN** rows appear in the order `waiting`, `running`, `idle`

#### Scenario: Reverse
- **WHEN** the user presses `r`
- **THEN** the row order reverses and the header marker shows the direction

### Requirement: Filtering
Pressing `/` SHALL open a filter prompt. The filter SHALL match case-insensitively against title, cwd, harness, model, and pid. `Enter` SHALL apply it, `Esc` SHALL clear it. While a filter is active the header SHALL show it and the counts of shown versus total sessions.

#### Scenario: Filter by cwd
- **WHEN** the user filters by `api` and one of three sessions has a cwd containing `api`
- **THEN** only that row is shown and the header reads `1/3`

#### Scenario: Clear filter
- **WHEN** the user presses `Esc` with a filter active
- **THEN** all rows are shown again

### Requirement: Closed sessions
`aya` SHALL remember sessions that closed while it was running. Pressing `c`, or starting with `--all`, SHALL toggle showing them as dimmed rows with status `closed`. Closed sessions SHALL NOT be counted in the live totals.

#### Scenario: Show closed
- **WHEN** a session has closed and the user presses `c`
- **THEN** it appears dimmed with status `closed` and the live count excludes it

### Requirement: Help and quit
Pressing `?` or `h` SHALL toggle a help overlay listing key bindings. Pressing `q` or `Ctrl+C` SHALL exit. On any exit, including `SIGINT`, `SIGTERM`, or an uncaught error, `aya` SHALL stop the instance, restore the terminal (main screen, cursor visible, raw mode off), and exit 0 on user quit or non-zero on error.

#### Scenario: Quit restores terminal
- **WHEN** the user presses `q`
- **THEN** the instance is stopped, the original screen and cursor are restored, and the process exits 0

#### Scenario: Crash restores terminal
- **WHEN** an uncaught error occurs while the TUI is open
- **THEN** the terminal is restored before the error is printed to stderr and the process exits non-zero

### Requirement: Provider errors
A provider `error` event SHALL NOT crash `aya`. The most recent provider error SHALL be shown on a status line with the provider id until the next error or until dismissed with a keypress.

#### Scenario: Provider throws
- **WHEN** a provider emits an error while `aya` is open
- **THEN** the table keeps updating and a status line shows the provider id and message

### Requirement: One-shot output
With `--once`, or when stdout is not a TTY, `aya` SHALL wait for `ready`, print one plain-text table of live sessions (no ANSI escapes when stdout is not a TTY or `NO_COLOR` is set), stop the instance, and exit 0. With `--json` it SHALL instead print a JSON array of live sessions containing their id, harness, provider, pid, status, waitingFor, title, cwd, model, kind, startedAt, updatedAt, and activity, then exit 0. `--all` SHALL have no effect in one-shot modes.

#### Scenario: Piped output
- **WHEN** the user runs `aya | cat` with two live sessions
- **THEN** a header line and two plain-text rows are printed with no escape sequences and the process exits 0

#### Scenario: JSON
- **WHEN** the user runs `aya --json` with no live sessions
- **THEN** `[]` is printed and the process exits 0
