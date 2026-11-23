import type { SentMessage } from './protocol.js';

// The view finds each sent message in the text rows of the terminal. A row position is
// derived: it is the row where the terminal shows the text of the message. The
// application decides how it shows a message, so a message can have no position.

// A message can follow a prompt on its first row, such as `> ` or `demo> `. leadLimit is
// the most characters of such a prompt, without spaces.
const leadLimit = 6;
// A frame character can follow a message on its last row. tailLimit is the most
// characters after the message, without spaces.
const tailLimit = 2;
// A longer prompt, such as a shell prompt, must end with one of these characters.
const promptEnd = /[$%#>❯›➜»]/;
// The start of a first line alone is weak evidence. The search uses at most prefixLength
// characters of the line, without spaces, and needs at least prefixMinimum.
const prefixMinimum = 12, prefixLength = 32;

const spaces = /\s+/g;
const word = /[\p{L}\p{N}]/u;

// sentText returns the text that Send wrote for a message: the text, then each attached
// file path in single quotes on its own line. It follows composeInput in composer.ts.
export function sentText(message: Pick<SentMessage, 'text' | 'attachments'>): string {
  const paths = message.attachments.map(file => "'" + file.path.replaceAll("'", "'\\''") + "'");
  return (message.text + (message.text && paths.length ? '\n\n' : '') + paths.join('\n')).replace(/\r\n?/g, '\n');
}

// The rows without spaces, as one text. An application wraps and indents a message for
// the terminal width, so the search ignores all spaces and line breaks.
interface Rows { rows: readonly string[]; text: string; starts: number[] }

function join(rows: readonly string[]): Rows {
  const starts: number[] = [];
  let text = '';
  for (const row of rows) {
    starts.push(text.length);
    text += row.replace(spaces, '');
  }
  starts.push(text.length);
  return { rows, text, starts };
}

// rowAt returns the row that holds the character at offset.
function rowAt(starts: readonly number[], offset: number): number {
  let low = 0, high = starts.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle; else high = middle - 1;
  }
  return low;
}

// startsRow tells whether the text at offset starts its row, after at most a prompt. A
// short prompt needs a space, or a character that is not a letter or a digit, before
// the text. Thus `demo> yes` starts with the message `yes`, and `eyes` does not. A
// longer prompt must end with a prompt character, as `user@host ~/orbit % ` does.
function startsRow(joined: Rows, offset: number): boolean {
  const row = rowAt(joined.starts, offset);
  const lead = offset - (joined.starts[row] ?? 0);
  if (lead === 0) return true;
  const text = joined.rows[row] ?? '';
  let seen = 0, index = 0;
  for (; index < text.length && seen < lead; index++) if (!/\s/.test(text.charAt(index))) seen++;
  // index is now after the last prompt character.
  const last = text.charAt(index - 1);
  if (promptEnd.test(last)) return true;
  return lead <= leadLimit && (/\s/.test(text.charAt(index)) || !word.test(last));
}

// endsRow tells whether the text that ends before offset ends its row. Only a few
// characters that are not letters or digits can follow it.
function endsRow(joined: Rows, end: number): boolean {
  const row = rowAt(joined.starts, end - 1);
  const rest = joined.text.slice(end, joined.starts[row + 1]);
  return rest.length <= tailLimit && !word.test(rest);
}

// find returns the offset of the first place at or after from where needle passes the
// checks, or -1.
function find(joined: Rows, needle: string, from: number, start: boolean, end: boolean): number {
  if (!needle) return -1;
  for (let offset = joined.text.indexOf(needle, from); offset >= 0; offset = joined.text.indexOf(needle, offset + 1)) {
    if ((!start || startsRow(joined, offset)) && (!end || endsRow(joined, offset + needle.length))) return offset;
  }
  return -1;
}

// locate returns the row of each message in rows, or -1 for a message that the rows do
// not show. messages are the sent texts in send order, and rows are the text rows of the
// terminal from the oldest row. A message is searched after the message before it, so
// that a later quote of an earlier message is not taken for a message.
//
// The search tries these forms of a message in order, and takes the first that it finds:
// 1. All of the text, at the start of a row and to the end of a row.
// 2. The first line, at the start of a row and to the end of a row. An application can
//    show a long message in a shorter form.
// 3. The start of the first line, at the start of a row.
export function locate(rows: readonly string[], messages: readonly string[]): number[] {
  const joined = join(rows);
  let from = 0;
  return messages.map(message => {
    const all = message.replace(spaces, '');
    const first = (message.trim().split('\n')[0] ?? '').replace(spaces, '');
    const prefix = first.slice(0, prefixLength);
    const forms: [string, boolean, boolean][] = [
      [all, true, true],
      [first === all ? '' : first, true, true],
      [prefix.length >= prefixMinimum ? prefix : '', true, false],
    ];
    for (const [needle, start, end] of forms) {
      const offset = find(joined, needle, from, start, end);
      if (offset < 0) continue;
      from = offset + needle.length;
      return rowAt(joined.starts, offset);
    }
    return -1;
  });
}

// currentMark returns the index of the message that the view reads: the last message at
// or above the top row of the view. rows are the rows of the located messages, from the
// oldest. pinned is the index of the last jump target while the view did not scroll, or
// -1. A jump to a message near the end of the output cannot put its row at the top.
export function currentMark(rows: readonly number[], top: number, pinned = -1): number {
  if (pinned >= 0 && pinned < rows.length) return pinned;
  let current = -1;
  rows.forEach((row, index) => { if (row <= top) current = index; });
  return current;
}

// stepMark returns the index of the message for a step to the earlier (-1) or the later
// (1) message. It returns 'end' for a step after the last message, to the latest output,
// and null when no earlier message is there. A step to the earlier message first goes to
// the start of the message that the view reads.
export function stepMark(rows: readonly number[], top: number, pinned: number, direction: -1 | 1): number | 'end' | null {
  const held = pinned >= 0 && pinned < rows.length;
  if (direction === 1) {
    const next = held ? pinned + 1 : rows.findIndex(row => row > top);
    return next >= 0 && next < rows.length ? next : 'end';
  }
  const current = currentMark(rows, top, pinned);
  if (current < 0) return null;
  if (!held && (rows[current] ?? 0) < top) return current;
  return current > 0 ? current - 1 : null;
}

// stepShortcut returns the step of a key: Command+Up and Command+Down on macOS, or
// Ctrl+Shift+Up and Ctrl+Shift+Down. It returns 0 for each other key. Ctrl+Up and
// Ctrl+Down stay available to terminal programs.
export function stepShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): -1 | 0 | 1 {
  const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (!direction || event.altKey) return 0;
  const command = event.metaKey && !event.ctrlKey && !event.shiftKey;
  const control = event.ctrlKey && event.shiftKey && !event.metaKey;
  return command || control ? direction : 0;
}

// inTerminal tells whether a message was sent while a terminal ran. Without a terminal,
// each message passes.
export function inTerminal(created: string, terminal?: { started: string; ended: string }): boolean {
  if (!terminal) return true;
  const time = Date.parse(created), start = Date.parse(terminal.started), end = Date.parse(terminal.ended);
  if (Number.isNaN(time)) return true;
  return !(time < start) && !(time > end);
}

// messageTime shows a local time. It shows the date too when the date is not today.
export function messageTime(created: string, now = new Date(), locale?: string, timeZone?: string): string {
  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return '';
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone });
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date);
  return day.format(date) === day.format(now) ? time : `${day.format(date)} ${time}`;
}
