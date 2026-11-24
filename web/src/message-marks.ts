import type { SentMessage, SentPage } from './protocol.js';

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

// findLast returns the offset of the last place where needle passes the checks and ends
// at or before limit, or -1.
function findLast(joined: Rows, needle: string, limit: number, start: boolean, end: boolean): number {
  // lastIndexOf takes a negative position as 0. The text then ends after the limit.
  if (!needle || limit < needle.length) return -1;
  for (let offset = joined.text.lastIndexOf(needle, limit - needle.length); offset >= 0; offset = offset > 0 ? joined.text.lastIndexOf(needle, offset - 1) : -1) {
    if ((!start || startsRow(joined, offset)) && (!end || endsRow(joined, offset + needle.length))) return offset;
  }
  return -1;
}

// locate returns the row of each message in rows, or -1 for a message that the rows do
// not show. messages are the sent texts in send order, and rows are the text rows of the
// terminal from the oldest row.
//
// The search takes the messages from the newest to the oldest. It takes the last place
// of each message, above the place of the message after it. An application that draws
// its output again, for example after a change of the terminal width, can leave earlier
// copies of a message in the scrollback. The last copy has the current output below it.
// Two messages with the same text thus also get their own rows.
//
// The search tries these forms of a message in order, and takes the first that it finds:
// 1. All of the text, at the start of a row and to the end of a row.
// 2. The first line, at the start of a row and to the end of a row. An application can
//    show a long message in a shorter form.
// 3. The start of the first line, at the start of a row.
// The rules for the row start and the row end keep a quote of a message in running text
// from the search.
export function locate(rows: readonly string[], messages: readonly string[]): number[] {
  const joined = join(rows);
  let limit = joined.text.length;
  const found = new Array<number>(messages.length).fill(-1);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] ?? '';
    const all = message.replace(spaces, '');
    const first = (message.trim().split('\n')[0] ?? '').replace(spaces, '');
    const prefix = first.slice(0, prefixLength);
    const forms: [string, boolean, boolean][] = [
      [all, true, true],
      [first === all ? '' : first, true, true],
      [prefix.length >= prefixMinimum ? prefix : '', true, false],
    ];
    for (const [needle, start, end] of forms) {
      const offset = findLast(joined, needle, limit, start, end);
      if (offset < 0) continue;
      limit = offset;
      found[index] = rowAt(joined.starts, offset);
      break;
    }
  }
  return found;
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

// The state of the message bar for a view position. current is the index of the message
// that the view reads, or -1. bottom tells that the view shows the latest output.
export interface BarState { current: number; previous: boolean; next: boolean; latest: boolean }

// barState returns the message of the bar and which of its buttons are available.
// Earlier message is available when a step has a target. Later message is available
// until the view shows the latest output after the last message.
export function barState(rows: readonly number[], top: number, pinned: number, bottom: boolean): BarState {
  return {
    current: currentMark(rows, top, pinned),
    previous: stepMark(rows, top, pinned, -1) !== null,
    next: rows.length > 0 && !(bottom && stepMark(rows, top, pinned, 1) === 'end'),
    latest: !bottom,
  };
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

// The most sent messages of one terminal that the view keeps, and the most sent messages
// of a session that the view reads to find them.
export const messageLimit = 200, readLimit = 1000;

// The sent messages that a view read for the terminal that it shows. The server gives
// pages from the newest message. messages are the read messages of the terminal, from
// the oldest. cursor is the revision of the oldest read message, or 0 before the first
// page. reached is the send time of that message. read counts all read messages. top is
// the revision of the newest read message.
export interface MessageCache { messages: SentMessage[]; cursor: number; reached: string; more: boolean; read: number; top: number }

export function emptyCache(): MessageCache {
  return { messages: [], cursor: 0, reached: '', more: false, read: 0, top: 0 };
}

// addPage adds a page to the cache. A page of older messages starts below the cursor.
// Without older, the page has the newest messages: the first page, or a reload after a
// send. The cache keeps only the messages of the terminal, and at most messageLimit of
// them. It drops the oldest first.
//
// A reload continues the cache only when its page reaches a message that the cache
// read before. Otherwise more messages than one page can lie between them, for example
// after a tab was offline. The cache then starts again from this page, and the view
// reads the older pages again.
export function addPage(cache: MessageCache, page: SentPage, older: boolean, terminal?: { started: string; ended: string }): MessageCache {
  const loaded = [...page.messages].reverse();
  const oldest = loaded[0], newest = loaded.at(-1);
  const kept = loaded.filter(message => inTerminal(message.created, terminal));
  if (older) {
    return {
      ...cache,
      messages: [...kept, ...cache.messages].slice(-messageLimit),
      cursor: oldest?.revision ?? cache.cursor,
      reached: oldest?.created ?? cache.reached,
      more: page.more,
      read: cache.read + loaded.length,
    };
  }
  const joins = cache.cursor !== 0 && !!oldest && oldest.revision <= cache.top;
  if (!joins) {
    return { messages: kept.slice(-messageLimit), cursor: oldest?.revision ?? 0, reached: oldest?.created ?? '', more: page.more, read: loaded.length, top: newest?.revision ?? 0 };
  }
  // The page reaches the read messages. Replace the part of the cache that it covers.
  const below = cache.messages.filter(message => message.revision < oldest.revision);
  const deeper = oldest.revision <= cache.cursor;
  return {
    messages: [...below, ...kept].slice(-messageLimit),
    cursor: deeper ? oldest.revision : cache.cursor,
    reached: deeper ? oldest.created : cache.reached,
    more: deeper ? page.more : cache.more,
    read: cache.read,
    top: Math.max(cache.top, newest?.revision ?? 0),
  };
}

// wantsOlder tells whether the view reads one more page of older messages. found tells
// that the terminal shows the oldest message of the cache.
// - Messages of a later terminal can fill the newest pages. The view then reads on until
//   it reaches the terminal that it shows, within readLimit.
// - A message from before the start of the terminal ends the read.
// - Otherwise the view reads on while the terminal still shows the oldest read message.
export function wantsOlder(cache: MessageCache, found: boolean, terminal?: { started: string; ended: string }): boolean {
  if (!cache.more || cache.read >= readLimit || cache.messages.length >= messageLimit) return false;
  if (terminal && Date.parse(cache.reached) < Date.parse(terminal.started)) return false;
  return cache.messages.length === 0 || found;
}
