## MODIFIED Requirements

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

## ADDED Requirements

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
