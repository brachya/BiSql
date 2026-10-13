export type Event<T> = (listener: (e: T) => unknown) => { dispose(): void };

export class Emitter<T> {
    private listeners = new Set<(e: T) => unknown>();

    public readonly event: Event<T> = (listener) => {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            }
        };
    };

    public fire(value: T): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(value);
            } catch (error) {
                // One listener must not stop the others. Schema refresh fires
                // after the cache is already updated.
                console.error(error);
            }
        }
    }

    public dispose(): void {
        this.listeners.clear();
    }
}
