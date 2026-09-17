## MODIFIED Requirements

### Requirement: Executable
The package SHALL install exactly one executable, named `all-your-agents` after the package so that `npx all-your-agents` resolves to it without a prior install. It SHALL NOT install an executable named `aya`, which is an unrelated package on the npm registry. The executable runs on Node ≥ 20 on macOS and Linux. It SHALL accept `--once`, `--json`, `--all`, `--help`, and `--version`. An unknown flag SHALL print usage to stderr and exit with status 2. The command SHALL add no runtime dependencies to the package.

#### Scenario: Help
- **WHEN** the user runs `all-your-agents --help`
- **THEN** usage listing every flag and key binding is printed to stdout and the process exits 0

#### Scenario: Unknown flag
- **WHEN** the user runs `all-your-agents --bogus`
- **THEN** usage is printed to stderr and the process exits 2

#### Scenario: Installed from tarball
- **WHEN** the packed tarball is installed into a fresh project and `npx all-your-agents --version` runs
- **THEN** it prints the package version and exits 0, and `node_modules/.bin` holds no `aya` entry

### Requirement: Live session table
In interactive mode `all-your-agents` SHALL take over the terminal (alternate screen, hidden cursor) and show one row per live session. Each row SHALL show status, harness, pid, title, cwd, model, current tool name, open subagent count, last turn outcome, and last-updated time. A header SHALL show the total number of live sessions and the count per status (`running`, `waiting`, `idle`). Values that are unknown SHALL render as `-`. Rows SHALL be truncated to the terminal width, never wrapped.

#### Scenario: Sessions already live
- **WHEN** two sessions are live before `all-your-agents` starts, one `running` and one `idle`
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
- **WHEN** a new session is created while `all-your-agents` is open
- **THEN** a row for it appears without any user input

#### Scenario: Status change
- **WHEN** a live session goes from `running` to `waiting`
- **THEN** its row and the header counts update

#### Scenario: Agent exits
- **WHEN** a live session closes and closed sessions are hidden
- **THEN** its row is removed and the header counts update

### Requirement: Event-driven redraw
`all-your-agents` SHALL follow ADR 0001. It SHALL redraw only in response to a library event, a keypress, or a terminal resize, and SHALL coalesce bursts of events into at most one redraw per event-loop turn. It SHALL NOT use a timer to refresh the screen or re-query sessions. Times SHALL be shown as absolute wall-clock times rather than durations that would need to tick.

#### Scenario: Idle screen holds no timers
- **WHEN** `all-your-agents` is open and no session, key, or terminal size changes
- **THEN** no redraw happens and no `setTimeout` or `setInterval` is pending

#### Scenario: Burst of events
- **WHEN** ten events arrive in the same event-loop turn
- **THEN** the screen is written once

#### Scenario: Resize
- **WHEN** the terminal is resized
- **THEN** the screen redraws to the new dimensions

### Requirement: Closed sessions
`all-your-agents` SHALL remember sessions that closed while it was running. Pressing `c`, or starting with `--all`, SHALL toggle showing them as dimmed rows with status `closed`. Closed sessions SHALL NOT be counted in the live totals.

#### Scenario: Show closed
- **WHEN** a session has closed and the user presses `c`
- **THEN** it appears dimmed with status `closed` and the live count excludes it

### Requirement: Help and quit
Pressing `?` or `h` SHALL toggle a help overlay listing key bindings. Pressing `q` or `Ctrl+C` SHALL exit. On any exit, including `SIGINT`, `SIGTERM`, or an uncaught error, `all-your-agents` SHALL stop the instance, restore the terminal (main screen, cursor visible, raw mode off), and exit 0 on user quit or non-zero on error.

#### Scenario: Quit restores terminal
- **WHEN** the user presses `q`
- **THEN** the instance is stopped, the original screen and cursor are restored, and the process exits 0

#### Scenario: Crash restores terminal
- **WHEN** an uncaught error occurs while the TUI is open
- **THEN** the terminal is restored before the error is printed to stderr and the process exits non-zero

### Requirement: Provider errors
An `error` event SHALL NOT crash `all-your-agents`. The most recent error SHALL be shown on a status line, labelled with the provider id for a provider error or with the event name for a listener error, until the next error or until dismissed with a keypress.

#### Scenario: Provider throws
- **WHEN** a provider emits an error while `all-your-agents` is open
- **THEN** the table keeps updating and a status line shows the provider id and message

### Requirement: One-shot output
With `--once`, or when stdout is not a TTY, `all-your-agents` SHALL wait for `ready`, print one plain-text table of live sessions (no ANSI escapes when stdout is not a TTY or `NO_COLOR` is set), stop the instance, and exit 0. With `--json` it SHALL instead print a JSON array of live sessions containing their id, harness, provider, pid, status, waitingFor, title, cwd, model, kind, startedAt, updatedAt, and activity, then exit 0. `--all` SHALL have no effect in one-shot modes.

#### Scenario: Piped output
- **WHEN** the user runs `all-your-agents | cat` with two live sessions
- **THEN** a header line and two plain-text rows are printed with no escape sequences and the process exits 0

#### Scenario: JSON
- **WHEN** the user runs `all-your-agents --json` with no live sessions
- **THEN** `[]` is printed and the process exits 0
