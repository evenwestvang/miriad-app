/**
 * @cast/storage - Storage interface and implementations
 *
 * For now, just a placeholder. Real implementation comes in Phase 1.
 */
export interface Storage {
    initialize(): Promise<void>;
    close(): Promise<void>;
}
export declare class StubStorage implements Storage {
    initialize(): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map