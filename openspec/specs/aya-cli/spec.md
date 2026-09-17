# aya-cli Specification

## Purpose

The `all-your-agents` command: a `top`/`htop`-style terminal monitor that shows the live status of every coding-agent session on the machine, built on the public all-your-agents API.

## Requirements

### Requirement: Executable
The package SHALL install exactly one executable, named `all-your-agents` after the package so that `npx all-your-agents` resolves to it without a prior install. It SHALL NOT install an executable named `aya`, which is an unrelated package on the npm registry. The executable runs on Node ≥ 20 on macOS and Linux. It SHALL accept `--once`, `--json`, `--all`, `--history`, `--help`, and `--version`. An unknown flag SHALL print usage to stderr and exit with status 2. The command SHALL add no runtime dependencies to the package.

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
With `--once`, or when stdout is not a TTY, `all-your-agents` SHALL wait for `ready`, print one plain-text table of live sessions (no ANSI escapes when stdout is not a TTY or `NO_COLOR` is set), stop the instance, and exit 0. With `--json` it SHALL instead print a JSON array of live sessions containing their id, harness, provider, pid, status, waitingFor, title, cwd, model, kind, startedAt, updatedAt, and activity, then exit 0. With `--history`, both forms SHALL include every session the providers know, live or not, live sessions first and the rest newest first; in the table a session that is not live SHALL show status `closed`. `--all` SHALL have no effect in one-shot modes.

#### Scenario: Piped output
- **WHEN** the user runs `all-your-agents | cat` with two live sessions
- **THEN** a header line and two plain-text rows are printed with no escape sequences and the process exits 0

#### Scenario: JSON
- **WHEN** the user runs `all-your-agents --json` with no live sessions
- **THEN** `[]` is printed and the process exits 0

#### Scenario: History as JSON
- **WHEN** the user runs `all-your-agents --json --history` with one live session and two that have ended
- **THEN** three objects are printed, the live one first with its `pid`, the others without a `pid`

### Requirement: History view
Pressing `H`, or starting with `--history`, SHALL load every session the providers know and show the ones that are not live in the same table as dimmed rows with status `closed`, alongside the live rows. Sorting, filtering, selection, and the detail view (including subagents) SHALL work on them as on live rows. They SHALL NOT be counted in the live totals. The header SHALL show that history is shown and how many historical sessions were loaded, and SHALL indicate loading until they arrive. Pressing `H` again SHALL remove the rows that came from history and keep live rows and sessions that closed while the command was running. History SHALL be read once per `H` press and never on a timer. A session that is live SHALL keep its live row when history also lists it.

#### Scenario: Browse yesterday's sessions
- **WHEN** one session is live, two ended before the command started, and the user presses `H`
- **THEN** three rows are shown, the two historical ones dimmed with status `closed`, and the header still reads `1 live`

#### Scenario: Back to live
- **WHEN** history is shown and the user presses `H`
- **THEN** only live rows remain, plus sessions that closed during this run if closed sessions are shown

#### Scenario: Filter across history
- **WHEN** history is shown and the user filters by `api`
- **THEN** only rows, live or historical, matching `api` are shown and the header reads shown over total

#### Scenario: Detail of a historical session
- **WHEN** the user presses `Enter` on a historical row whose session ran two subagents
- **THEN** the detail view lists both subagents with their final status

#### Scenario: Live session also in history
- **WHEN** a live session also has a journal that history lists
- **THEN** it appears once, as a live row

### Requirement: Transcript view
Pressing `t` on the selected session, live or historical, SHALL open a full-screen transcript of its conversation in order: user prompts, assistant replies with the model when known, tool calls, tool failures, subagent launches, errors, and each turn's outcome, with clock times where the records have them. Text SHALL be wrapped to the terminal width, never truncated, and every character from a transcript SHALL be sanitized so it cannot emit terminal control sequences. The view SHALL open scrolled to the end. `↑`/`↓`, `k`/`j`, `PgUp`/`PgDn`, `Home`, and `End` SHALL scroll; `t` or `Esc` SHALL close it and return to the view it was opened from, with the same selection. While the view is scrolled to the end it SHALL stay at the end as records are appended; once the user scrolls up it SHALL stay where it is. The transcript SHALL be read through a single event stream that is released when the view closes or the command exits. A session whose provider has no history SHALL show an empty transcript, not an error.

#### Scenario: Read what an agent said
- **WHEN** the user presses `t` on a session whose journal holds a prompt, a reply, a tool call, and a completed turn
- **THEN** the screen shows them in that order, and the footer shows how to scroll and close

#### Scenario: Live session keeps up
- **WHEN** the transcript of a live session is open at the end and the agent writes a new reply
- **THEN** the reply appears without any key being pressed, and the view is still at the end

#### Scenario: Scrolled up stays put
- **WHEN** the user has scrolled up and new records are appended
- **THEN** the lines on screen do not move

#### Scenario: Close releases the stream
- **WHEN** the user presses `Esc` in the transcript view
- **THEN** the table returns with the same session selected, and the journal is no longer watched

#### Scenario: Hostile transcript text
- **WHEN** a reply contains terminal escape sequences
- **THEN** they are shown as inert text and the terminal state is unchanged

#### Scenario: Long transcript opens once
- **WHEN** a transcript of several thousand records is opened
- **THEN** the records already stored are drawn in at most a few redraws, not one per record
