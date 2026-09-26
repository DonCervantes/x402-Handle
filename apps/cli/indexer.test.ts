import { describe, expect, test } from "bun:test";

import { fetchAndProcessSorobanEvents } from "./indexer";

describe("fetchAndProcessSorobanEvents", () => {
    test("pages through catch-up windows until the ledger gap is empty", async () => {
        const cursorCalls: number[] = [];

        const nextLedger = await fetchAndProcessSorobanEvents({
            fromLedger: 300,
            latestLedger: 305,
            limit: 2,
            fetchPage: async (cursor) => {
                cursorCalls.push(cursor);

                if (cursor === 300) {
                    return [{ ledger: 301 }, { ledger: 302 }];
                }
                if (cursor === 303) {
                    return [{ ledger: 304 }];
                }
                return [];
            },
            onPage: async () => { },
        });

        expect(cursorCalls).toEqual([300, 303, 305]);
        expect(nextLedger).toBe(306);
    });

    test("keeps paginating when the event window exceeds POLL_LIMIT", async () => {
        const cursorCalls: number[] = [];

        const nextLedger = await fetchAndProcessSorobanEvents({
            fromLedger: 1000,
            latestLedger: 1015,
            limit: 2,
            fetchPage: async (cursor) => {
                cursorCalls.push(cursor);

                if (cursor === 1000) {
                    return [{ ledger: 1001 }, { ledger: 1002 }];
                }
                if (cursor === 1003) {
                    return [{ ledger: 1004 }, { ledger: 1005 }];
                }
                if (cursor === 1006) {
                    return [{ ledger: 1007 }];
                }
                return [];
            },
            onPage: async () => { },
        });

        expect(cursorCalls).toEqual([1000, 1003, 1006, 1008]);
        expect(nextLedger).toBe(1016);
    });
});
