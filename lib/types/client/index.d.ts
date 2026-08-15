/** Client plugin: register the floating panel in shell.overlay. */
export declare const inject: readonly string[];
export declare function apply(ctx: {
    get(name: string): unknown;
    effect(fn: () => (() => void) | undefined): void;
}): void;
