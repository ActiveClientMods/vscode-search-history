import type { HistoryStore } from '../core/storage';
import type { HistoryTreeProvider } from '../views/historyProvider';
import type { SearchBarViewProvider } from '../views/searchBarView';

/** Everything the command handlers operate on, injected once at registration. */
export interface CommandDeps {
	store: HistoryStore;
	provider: HistoryTreeProvider;
	searchBar: SearchBarViewProvider;
}

/** Registers a command and pushes its disposable onto the extension context. */
export type RegisterFn = (command: string, handler: (...args: unknown[]) => unknown) => void;
