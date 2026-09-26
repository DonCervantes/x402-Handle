import { describe, expect, test } from "bun:test";
import {
    findMatchingPaymentOps,
    getPaymentOperationAmount,
    paymentOpMatchesExpected,
} from "../src/verify";

describe("stellar payment verification helpers", () => {
    const issuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const destination = "GBQ5H6E3P3R4RMYQ7M6H7Y7KXJ6ZQ7H3V7S3Q4N7QW3Q4Z7Y7K7E6JY";

    test("reads destination_amount for strict path payments", () => {
        const op = {
            type: "path_payment_strict_receive",
            to: destination,
            destination_asset_type: "credit_alphanum4",
            destination_asset_code: "USDC",
            destination_asset_issuer: issuer,
            destination_amount: "0.005",
            amount: "10.0",
        };

        expect(getPaymentOperationAmount(op)).toBe("0.005");
        expect(paymentOpMatchesExpected(op, issuer, destination, "0.005")).toBe(true);
    });

    test("requires all payment ops in multi-op transactions to match", () => {
        const paymentOps = [
            {
                type: "payment",
                from: "GUSER",
                to: destination,
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: issuer,
                amount: "0.005",
            },
            {
                type: "payment",
                from: "GOTHER",
                to: "GDIFFERENT",
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: issuer,
                amount: "0.005",
            },
        ];

        expect(findMatchingPaymentOps(paymentOps, issuer, destination, "0.005")).toHaveLength(1);
    });
});
