import { replaces, restartedMessage, serverReplaced } from './restart.js';

// The browser and Go CLI use the same protocol. Each connection carries one request.
export const VERSION = 'bbflow/42';

// After a lost connection, a view tries again with increasing delays up to this limit.
// A short limit lets open tabs find a restarted server soon.
export const retryLimit = 5000;

// These types match internal/protocol/protocol.go.
export interface Size { rows: number; cols: number }

export interface ServerInfo {
  protocol: string;
  instance: string;
  pid: number;
  dataDir: string;
  port: number;
  executable: string;
}

// A newer bbflow release for the server. revision identifies the offer. It changes when
// a check finds another release or another action. version is the version of the
// running server. installed means that the executable already has the release, so the
// update only restarts the server. error tells why the last update failed.
export interface Update { revision: number; version: string; available: string; installed?: boolean; state: 'available' | 'updating' | 'failed'; error?: string }

export interface Project { id: string; name: string; workspace: string; created: string }

// type is codex, claude, agy, code-puppy, or custom. model and effort are the defaults of
// new drafts. An empty value selects the default of the CLI. builtin marks the preset of
// an agent type, which the server owns. enabled is false for a built-in tool that is off.
// A tool that is off is not a choice for new sessions. path is the optional CLI path of a
// built-in tool. The server runs it for the model list, the check for the CLI, and the
// title tool. An empty path selects the plain CLI name.
export interface Tool { id: string; name: string; command: string; type: string; model: string; effort: string; builtin: boolean; enabled: boolean; path: string }
// One choice of a model list. efforts lists its thinking efforts. default is the effort of
// the CLI when bbflow adds no effort option.
export interface ToolModel { id: string; name: string; efforts: string[]; default?: string }
// The model list of a tool type. source is the command that printed it, or empty for a
// built-in list. efforts lists the efforts for any model. loaded is the time of the list.
export interface ToolModels { type: string; source: string; models: ToolModel[]; efforts: string[]; loaded: string }
// port 0 selects the automatic port. A saved port applies at the next server start.
// remoteOn is the switch of remote access. Remote access works only while it is on and
// remoteHost and remoteLogin are both set.
// titleCommand is the command of the custom title tool. It stays saved when another title
// tool is selected.
// shellOff turns off the built-in Shell, the tool with the empty ID.
export interface Settings { revision: number; appearance: string; defaultTool: string; shellOff: boolean; worktree: boolean; base: string; tools: Tool[]; titleTool: string; titleCommand: string; titleModel: string; titleEffort: string; updateCheck: boolean; port: number; remoteOn: boolean; remoteHost: string; remoteLogin: string }
// The server owns the command of each built-in title tool. Settings.titleTool is none, a
// built-in tool ID, or custom.
// command is the command with the default model and effort. For a title tool with a
// type, the command with another model is prefix, the model and effort options, then
// suffix. model and effort are the defaults.
export interface TitleTool { id: string; name: string; command: string; type?: string; prefix?: string; suffix?: string; model?: string; effort?: string }
// sample is the message that a title test sends to the title tool.
export interface TitleTools { tools: TitleTool[]; sample: string }
// toolType is empty for Shell. The launch adds the options of model and effort to command.
export interface Preparation { revision: number; state: string; toolId: string; toolName: string; toolType: string; command: string; model: string; effort: string; worktree: boolean; base: string; branch: string }
export interface Worktree { path: string; repository: string; base: string; commit: string; branch: string; state: string }
export interface Run { id: string; status: string }
// One terminal of a session. number counts from 1 in start order. A new terminal has an
// empty run until its process starts.
export interface TerminalInfo { number: number; run: string; tool: string; status: string; started: string; ended: string }
// status is the session status that the server derives. run.status is the stored status
// of the latest run.
// title is the title that the user set, or empty. autoTitle is derived by the server.
// parentId is the top-level session of a sub-session, or empty.
export interface PreparedSession { archived: boolean; pinned: boolean; id: string; projectId: string; parentId?: string; title: string; autoTitle?: string; workspace: string; status: string; preparation?: Preparation; worktree?: Worktree; run?: Run }
// bbflow writes the handoff folder before it starts a new terminal in an ended session.
// available means that the folder has a README, so the prompt can be used now.
export interface Handoff { folder: string; prompt: string; available: boolean }
export interface RepositoryInfo { available: boolean; root: string; head: string; branch: string; reason: string }

// status is draft, running, idle, or ended.
// more holds the keys of the groups that have more families. A family lists its
// top-level session first, then its sub-sessions in creation order.
export interface SessionPage { sessions: SessionInfo[]; more: string[] }
// parentId is the top-level session of a sub-session, or empty. context marks a
// top-level session that shows only as the parent of listed sub-sessions. pinned marks a
// pinned top-level session.
export interface SessionInfo {
  archived: boolean;
  pinned: boolean;
  parentId: string;
  context?: boolean;
  preparation?: Preparation;
  worktree?: Worktree;
  projectId: string;
  id: string;
  title: string;
  autoTitle: string;
  workspace: string;
  updated: string;
  status: string;
  // The stored status of the latest run: exited, stopped, failed, or interrupted after
  // the end. It is absent for a draft.
  runStatus?: string;
  viewers: number;
}

export interface Draft {
  revision: number;
  text: string;
  attachments: number[];
  pending: boolean;
}
export interface Attachment { id: number; name: string; mediaType: string; size: number; path: string }
// A save reply sets rejected when the server kept a send from another view. The reply
// then holds the latest draft.
export interface ComposerState { draft: Draft; attachments: Attachment[]; rejected?: boolean }
// A sent message is derived from the pending draft revision that the editor saves
// before each send. Confirmed means that the editor got an input receipt. It does not
// mean that the application accepted the message.
export interface SentMessage { revision: number; created: string; text: string; attachments: Attachment[]; confirmed: boolean }
export interface SentPage { messages: SentMessage[]; more: boolean }
export type HistoryScope = 'session' | 'project' | 'all';
export interface HistoryFilter { query: string; scope: HistoryScope; session?: string; project?: string; matchCase: boolean; cursor?: HistoryCursor; limit?: number; through?: number }
export interface HistoryAnchor { session: string; run: string; seq: number; offset: number; length: number; through: number }
export interface HistoryDisplay { before: string; match: string; after: string }
export interface HistoryContext { display?: HistoryDisplay; before: string; match: string; after: string; moreBefore: boolean; moreAfter: boolean; lastSeq: number }
export interface HistoryHit { anchor: HistoryAnchor; title: string; workspace: string; terminal: number; tool: string; created: string; context: HistoryContext }
export interface HistoryCursor { seq: number; offset: number }
export interface HistoryPage { matches: HistoryHit[]; more: boolean; incomplete: boolean; through: number; cursor?: HistoryCursor }
// Read-only diff and file views. The server resolves the workspace from the session.
// baseline "base" uses the managed worktree commit. "head" uses HEAD. "commit" shows the
// changes from the `from` commit: it uses the first parent of that commit.
export type BaselineKind = 'base' | 'head' | 'commit';
// A "commit" baseline selects the commits from `from` to `to`. Without `to`, the new side
// is the current files.
export interface DiffRequest { baseline?: BaselineKind; from?: string; to?: string; path?: string; oldPath?: string; folders?: string[] }
export interface Baseline { kind: BaselineKind; label: string; commit: string; from?: string; to?: string }
// The start of the "base" baseline. branch names the default branch of a merge base. It
// is empty for the recorded commit of a managed worktree.
export interface Base { commit: string; branch?: string }
// A commit since the base. files counts the files that it changes in the workspace.
export interface Commit { id: string; subject: string; files: number }
// added and removed are -1 when they are unknown. An untracked file has status A.
export interface ChangedFile { path: string; oldPath?: string; status: string; added: number; removed: number; binary?: boolean; untracked?: boolean }
// commits lists the commits since the base, newest first.
export interface WorkspaceChanges { repository: boolean; reason?: string; base?: Base; baseline: Baseline; commits: Commit[]; moreCommits?: boolean; files: ChangedFile[]; truncated: boolean }
export interface WorkspaceFiles { repository: boolean; reason?: string; paths: string[]; truncated: boolean }
// A folder list. An empty path names the workspace folder. `missing` reports that the
// path is not a folder now.
export interface FolderEntry { name: string; kind: 'folder' | 'file' | 'symlink' | 'other'; ignored?: boolean }
export interface WorkspaceFolder { path: string; missing?: boolean; entries: FolderEntry[]; truncated?: boolean }
export interface WorkspaceFolders { folders: WorkspaceFolder[]; ignoreError?: string }
// An image side has its media type and its bytes in base64.
export interface FileSide { state: 'text' | 'missing' | 'binary' | 'image' | 'tooLarge' | 'other'; text?: string; mediaType?: string; data?: string; size: number; symlink?: boolean }
export interface WorkspaceFile { path: string; baseline: Baseline; old: FileSide; new: FileSide }
type ChangesRequest = { operation: 'workspace-changes'; session: string; diff: DiffRequest };
type FilesRequest = { operation: 'workspace-files'; session: string };
type FoldersRequest = { operation: 'workspace-folders'; session: string; diff: DiffRequest };
type FileRequest = { operation: 'workspace-file'; session: string; diff: DiffRequest };
type OpenRequest = { operation: 'workspace-open'; session: string; diff: DiffRequest };
type RevealRequest = { operation: 'workspace-reveal'; session: string; diff: DiffRequest };
export type DiffRPC = ChangesRequest | FilesRequest | FoldersRequest | FileRequest | OpenRequest | RevealRequest;
type HistorySearchRequest = { operation: 'history-search'; search: HistoryFilter };
type HistoryContextRequest = { operation: 'history-context'; context: { anchor: HistoryAnchor; before: number; after: number } };
type DraftRequest = { operation: 'composer-draft'; session: string; draft?: Draft };
type SentRequest = { operation: 'composer-sent'; session: string; revision?: number };
type UploadRequest = { operation: 'composer-attach'; session: string; upload: { name: string; mediaType: string; data: string } };

// limit applies to the families of each listed group. limit times the number of groups
// must be at most 100. offset skips the first families of one group. A group key is a
// project ID, '' for Standalone, or 'pinned' for Pinned. Without offset, the list includes
// session outside its group limit.
type ListRequest = { operation: 'session-list'; limit?: number; groups: string[]; offset?: number; session?: string; archived?: boolean; query?: string };
// Archive of a top-level session also archives its sub-sessions. Restore of a top-level
// session also restores its sub-sessions. Restore of a sub-session also restores its parent.
// members are the sub-sessions that the user confirmed for the archive of a top-level
// session. The server then archives nothing if the family has other sub-sessions.
type ArchiveRequest = { operation: 'session-archive'; session: string; archived: boolean; members?: string[] };
// A pin moves the family of a top-level session to the Pinned group. Archive removes it.
type PinRequest = { operation: 'session-pin'; session: string; pinned: boolean };
type StopSessionRequest = { operation: 'session-stop'; session: string };
type ProjectListRequest = { operation: 'project-list' };
type ProjectAddRequest = { operation: 'project-add'; name: string; workspace: string };
type RenameRequest = { operation: 'project-rename'; project: string; name: string } | { operation: 'session-rename'; session: string; name: string };
type ProjectRemoveRequest = { operation: 'project-remove'; project: string };
type SettingsRequest = { operation: 'settings-get' } | { operation: 'settings-save'; settings: Settings };
// The title tool of a test or a change. Only custom takes titleCommand, and it needs
// one. The server does not use the saved custom command in its place. The client sends
// the custom command that it shows.
type TitleChoice = Pick<Settings, 'titleTool'> & Partial<Pick<Settings, 'titleCommand' | 'titleModel' | 'titleEffort'>>;
// title-test runs a title tool once with the sample message and saves nothing.
type TitleTestRequest = { operation: 'title-test'; settings: TitleChoice };
// title-tool-set saves a title tool after it passes the same test. None has no test.
type TitleToolSetRequest = { operation: 'title-tool-set'; settings: TitleChoice };
type TitleToolsRequest = { operation: 'title-tools' };
type ToolModelsRequest = { operation: 'tool-models'; toolType: string; refresh?: boolean };
type ToolCheckRequest = { operation: 'tool-check' };
type InspectRequest = { operation: 'workspace-inspect'; workspace: string };
// The server does what the offer with this version and revision says, then restarts.
// The restart ends all sessions.
type UpdateRequest = { operation: 'update-start'; version: string; revision: number };
// A parent creates a sub-session draft in the family and project of that session.
type PrepareRequest = { operation: 'project-draft'; project: string } | { operation: 'project-draft'; parent: string };
type ConfigRequest = { operation: 'session-config'; session: string; preparation?: Pick<Preparation, 'revision' | 'toolId' | 'model' | 'effort' | 'worktree' | 'base' | 'branch'>; name?: string };
type RemoveWorktreeRequest = { operation: 'worktree-remove'; session: string };
type HandoffRequest = { operation: 'session-handoff'; session: string };
type TerminalsRequest = { operation: 'session-terminals'; session: string };
// shell stops only that shell. Without shell, the request stops the live shell.
type StopSideRequest = { operation: 'side-terminal-stop'; session: string; shell?: string };
type RPCRequest = ToolCheckRequest | ToolModelsRequest | UpdateRequest | DiffRPC | TitleTestRequest | TitleToolSetRequest | TitleToolsRequest | StopSideRequest | HistorySearchRequest | HistoryContextRequest | HandoffRequest | TerminalsRequest | ArchiveRequest | PinRequest | SettingsRequest | InspectRequest | PrepareRequest | ConfigRequest | RemoveWorktreeRequest | ListRequest | StopSessionRequest | DraftRequest | SentRequest | UploadRequest | ProjectListRequest | ProjectAddRequest | RenameRequest | ProjectRemoveRequest;
export type StreamRequest =
  | { operation: 'session-start'; session: string; revision: number; size: Size }
  // run shows an earlier terminal. Without run, the view shows the latest terminal.
  | { operation: 'session-resume'; session: string; size: Size; run?: string }
  // latestRun is the latest run that this view saw. An empty tool selects Shell.
  | { operation: 'session-continue'; session: string; latestRun: string; tool: string; size: Size }
  // A side terminal is an unrecorded shell in the session workspace. Open starts a shell
  // when none runs. Resume only joins a live shell.
  | { operation: 'side-terminal-open'; session: string; size: Size }
  // shell rejoins only that shell. Without shell, the view joins the live shell.
  | { operation: 'side-terminal-resume'; session: string; size: Size; shell?: string };
// A watch stream stays open. The server pushes its latest state and each later change.
export type WatchRequest = { operation: 'composer-watch'; session: string } | { operation: 'status-watch' };
export type Request = RPCRequest | StreamRequest | WatchRequest;

export type ServerMessage =
  | { type: 'server'; server: ServerInfo }
  // shell identifies a side terminal shell. notice is a warning for the view that
  // started the session, such as a base fetch that failed.
  | { type: 'session'; session: string; active?: boolean; status?: string; shell?: string; notice?: string }
  // A live view gets running or idle after it joins and after each change.
  | { type: 'status'; status: string }
  | { type: 'frame'; data?: string; size: Size; revision: number; full?: boolean }
  | { type: 'pong' }
  | { type: 'input-ack'; id: string; error?: string }
  // status is the recorded status of the run: exited, stopped, or failed. run is empty
  // when the terminal failed before its run started.
  | { type: 'exit'; code?: number; status?: string; run?: string; error?: string }
  | { type: 'history-end' }
  | { type: 'draft'; session: string; composer: ComposerState }
  // A status watch gets running or idle for each session that has a live terminal.
  // revision counts session title changes since the server started. update offers a
  // newer release.
  | { type: 'statuses'; statuses?: Record<string, string>; revision?: number; update?: Update }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: string };

export type Control =
  | { type: 'input'; data: string; id?: string; report?: true }
  | { type: 'resize'; size: Size }
  | { type: 'signal'; signal: number }
  | { type: 'ping' };

interface Handlers {
  message?(message: ServerMessage): void;
  error?(error: Error): void;
  close?(): void;
}

type Socket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'onmessage' | 'onerror' | 'onclose' | 'send' | 'close'>;
type SocketConstructor = new (url: string) => Socket;

// Show the title that the user set. Without it, show the derived title.
export function sessionTitle(session: { title: string; autoTitle?: string }): string {
  return session.title || session.autoTitle || '';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export function decodeBytes(data = ''): Uint8Array {
  return Uint8Array.from(atob(data), char => char.charCodeAt(0));
}

export function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

// fromServer is true when the server replied with an error, for example a rejected value.
// It is false for a transport failure.
export class ConnectionError extends Error {
  constructor(message: string, readonly retryable = false, readonly fromServer = false) { super(message); }
}

// A title test runs an agent CLI. The server stops it after 90 seconds, so the browser
// waits a little longer for the reply. See titleTimeout in internal/server/titles.go.
export const titleTestLimit = 100000;
// A model list runs a list command of an agent CLI. The server stops it after 30 seconds,
// so the browser waits a little longer. See modelListTimeout in internal/server/models.go.
export const modelListLimit = 35000;
// The time that the browser waits for the reply of a request.
export const responseLimit = (request: Request) => {
  if (request.operation === 'title-test' || request.operation === 'title-tool-set') return titleTestLimit;
  if (request.operation === 'tool-models') return modelListLimit;
  return 12000;
};

export class Peer {
  readonly socket: Socket;
  active = false;
  private finished = false;
  private heartbeat: ReturnType<typeof setInterval>;
  private receivedAt = Date.now();
  private greeted = false;
  // True after the first message that follows the greeting.
  private replied = false;
  private timer: ReturnType<typeof setTimeout>;
  private input: { id: string; settle: (error?: string) => void } | undefined;

  constructor(
    server: ServerInfo,
    request: Request,
    private readonly handlers: Handlers,
    Socket: SocketConstructor = WebSocket,
    host = location.host,
  ) {
    // An HTTPS page cannot open ws://. Remote access through an HTTPS proxy uses wss://.
    const scheme = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new Socket(`${scheme}://${host}/ws`);
    const limit = responseLimit(request);
    this.timer = setTimeout(() => this.fail('Server response timed out.', true), limit);
    this.heartbeat = setInterval(() => {
      if (this.finished) return;
      // The server sends nothing until the first reply. Do not end the wait for it early.
      if (Date.now() - this.receivedAt > (this.replied ? 20000 : Math.max(20000, limit))) this.fail('Connection timed out. Input was not resent.', true);
      else if (this.greeted && this.active) this.send({ type: 'ping' });
    }, 5000);
    this.socket.onmessage = event => {
      if (this.finished) return;
      this.receivedAt = Date.now();
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        if (!this.greeted) {
          const info = message.type === 'server' ? message.server : undefined;
          if (message.type !== 'server' || !info || info.protocol !== VERSION ||
              info.protocol !== server.protocol || info.instance !== server.instance ||
              info.dataDir !== server.dataDir || info.port !== server.port) {
            if (message.type === 'server' && replaces(server, info)) {
              serverReplaced();
              throw new Error(restartedMessage);
            }
            throw new Error('The server changed or uses a different protocol. Reload this page.');
          }
          this.greeted = true;
          this.socket.send(JSON.stringify({ type: 'request', request: { ...request, protocol: VERSION } }));
          return;
        }
        clearTimeout(this.timer);
        this.replied = true;
        if (message.type === 'error') {
          this.fail(message.error || 'Request failed.', false, true);
          return;
        }
        // A live session or a watch keeps the connection open with ping.
        if (message.type === 'session') this.active = !!message.active;
        if (message.type === 'draft' || message.type === 'statuses') this.active = true;
        if (message.type === 'input-ack' && message.id === this.input?.id) this.input.settle(message.error);
        if (['exit', 'history-end', 'result'].includes(message.type)) {
          this.input?.settle('Input delivery was not confirmed. Check the terminal before submitting again.');
          this.finished = true;
          clearInterval(this.heartbeat);
          this.active = false;
        }
        this.handlers.message?.(message);
      } catch (error) {
        this.fail(errorMessage(error));
      }
    };
    this.socket.onerror = () => this.fail('Connection failed. Input was not resent.', true);
    this.socket.onclose = () => {
      clearTimeout(this.timer);
      this.active = false;
      if (!this.finished) {
        this.fail('Connection lost. Work may still be running. Input was not resent.', true);
      }
      this.handlers.close?.();
    };
  }

  fail(message: string, retryable = false, fromServer = false): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.heartbeat);
    this.active = false;
    clearTimeout(this.timer);
    this.input?.settle('Input delivery was not confirmed. Check the terminal before submitting again.');
    this.handlers.error?.(new ConnectionError(message, retryable, fromServer));
    this.socket.close();
  }

  send(message: Control): boolean {
    if (!this.active || this.socket.readyState !== 1) return false;
    if (this.socket.bufferedAmount > 1024 * 1024) {
      this.fail('Connection is too slow. Some input may have been delivered; reconnect before continuing.');
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  // Acknowledge the complete frame only after the parser finishes. This also applies to
  // ended views.
  acknowledgeFrame(revision: number): void {
    if (this.greeted && !this.finished && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify({ type: 'frame-ack', revision }));
    }
  }

  // This receipt confirms a PTY write. It does not confirm application acceptance or
  // completion. Never retry input. A successful write can have a lost receipt.
  writeInput(data: string, id: string = crypto.randomUUID()): Promise<void> {
    if (this.input) return Promise.reject(new Error('A submission is already in progress.'));
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.input?.settle('Input delivery was not confirmed. Check the terminal before submitting again.'), 8000);
      this.input = { id, settle: error => {
        clearTimeout(timeout);
        this.input = undefined;
        if (error) reject(new Error(error)); else resolve();
      } };
      try {
        if (!this.send({ type: 'input', id, data })) this.input?.settle('The terminal is not connected. Input was not sent.');
      } catch (error) { this.input?.settle(errorMessage(error)); }
    });
  }

  close(): void {
    this.input?.settle('Input delivery was not confirmed. Check the terminal before submitting again.');
    this.finished = true;
    clearInterval(this.heartbeat);
    this.active = false;
    clearTimeout(this.timer);
    this.socket.close();
  }
}

export function call(server: ServerInfo, request: SettingsRequest): Promise<Settings>;
export function call(server: ServerInfo, request: TitleTestRequest, signal?: AbortSignal): Promise<{ title: string }>;
export function call(server: ServerInfo, request: TitleToolSetRequest): Promise<{ settings: Settings; title: string }>;
export function call(server: ServerInfo, request: TitleToolsRequest): Promise<TitleTools>;
export function call(server: ServerInfo, request: ToolModelsRequest): Promise<ToolModels>;
// installed holds the agent types whose CLI is on the PATH of the server.
export function call(server: ServerInfo, request: ToolCheckRequest): Promise<{ installed: Record<string, boolean> | null }>;
export function call(server: ServerInfo, request: InspectRequest): Promise<RepositoryInfo>;
export function call(server: ServerInfo, request: UpdateRequest): Promise<{ updating: boolean }>;
export function call(server: ServerInfo, request: PrepareRequest | ConfigRequest): Promise<PreparedSession>;
export function call(server: ServerInfo, request: RemoveWorktreeRequest): Promise<{ removed: boolean }>;
export function call(server: ServerInfo, request: HandoffRequest): Promise<Handoff>;
export function call(server: ServerInfo, request: TerminalsRequest): Promise<TerminalInfo[]>;
export function call(server: ServerInfo, request: ProjectListRequest): Promise<Project[]>;
export function call(server: ServerInfo, request: ProjectAddRequest): Promise<Project>;
export function call(server: ServerInfo, request: RenameRequest): Promise<{ renamed: boolean }>;
export function call(server: ServerInfo, request: ProjectRemoveRequest): Promise<{ removed: boolean }>;
export function call(server: ServerInfo, request: ArchiveRequest): Promise<{ archived: boolean }>;
export function call(server: ServerInfo, request: PinRequest): Promise<{ pinned: boolean }>;
export function call(server: ServerInfo, request: ListRequest): Promise<SessionPage>;
export function call(server: ServerInfo, request: StopSessionRequest | StopSideRequest): Promise<{ stopped: boolean }>;
export function call(server: ServerInfo, request: DraftRequest): Promise<ComposerState>;
export function call(server: ServerInfo, request: SentRequest): Promise<SentPage>;
export function call(server: ServerInfo, request: HistorySearchRequest, signal?: AbortSignal): Promise<HistoryPage>;
export function call(server: ServerInfo, request: HistoryContextRequest, signal?: AbortSignal): Promise<HistoryContext>;
export function call(server: ServerInfo, request: UploadRequest): Promise<Attachment>;
export function call(server: ServerInfo, request: ChangesRequest, signal?: AbortSignal): Promise<WorkspaceChanges>;
export function call(server: ServerInfo, request: FilesRequest, signal?: AbortSignal): Promise<WorkspaceFiles>;
export function call(server: ServerInfo, request: FoldersRequest, signal?: AbortSignal): Promise<WorkspaceFolders>;
export function call(server: ServerInfo, request: FileRequest, signal?: AbortSignal): Promise<WorkspaceFile>;
export function call(server: ServerInfo, request: OpenRequest): Promise<{ opened: boolean }>;
export function call(server: ServerInfo, request: RevealRequest): Promise<{ revealed: boolean }>;
export function call(server: ServerInfo, request: RPCRequest, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new DOMException('Request canceled.', 'AbortError'));
  return new Promise<unknown>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const peer = new Peer(server, request, {
      message(message) {
        if (message.type === 'result') {
          cleanup();
          resolve(message.result);
          peer.close();
        }
      },
      error(error) { cleanup(); reject(error); },
    });
    const abort = () => {
      cleanup();
      peer.close();
      reject(new DOMException('Request canceled.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
