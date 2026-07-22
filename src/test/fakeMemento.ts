import type { Memento } from 'vscode';

/** In-memory `Memento` implementation for unit-testing the storage layer. */
export class FakeMemento implements Memento {
	private readonly data = new Map<string, unknown>();

	keys(): readonly string[] {
		return [...this.data.keys()];
	}

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.data.delete(key);
		} else {
			// Round-trip through JSON to mimic real Memento serialization semantics.
			this.data.set(key, JSON.parse(JSON.stringify(value)));
		}
	}
}
