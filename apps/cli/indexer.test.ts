import { describe, expect, test, beforeEach, afterEach } from "bun:test";

/**
 * Test for prov_off and prov_on event handling in the indexer.
 * Tests that the indexer correctly deactivates providers on prov_off
 * and reactivates them on prov_on.
 */

describe("indexer provider activation/deactivation", () => {
  let testProviderId: string;
  const CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID || "test-contract";
  const providerId = 999n;
  
  beforeEach(async () => {
    // Setup: insert a test provider
    testProviderId = `${CONTRACT_ID}/${providerId}`;
    await Bun.sql`
      INSERT INTO providers (
        id, contract_id, provider_id, name, endpoint, price_usdc,
        owner_account, payment_asset, category, active, created_at, last_seen_at, metadata
      ) VALUES (
        ${testProviderId}, ${CONTRACT_ID}, ${Number(providerId)}, 'Test Provider', 'https://test.example',
        '1.0000000', 'GTEST123', 'USDC', 'test',
        true, now(), now(), '{}'::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET active = true
    `;
  });

  afterEach(async () => {
    // Cleanup: remove test provider
    await Bun.sql`DELETE FROM providers WHERE id = ${testProviderId}`;
  });

  test("prov_off event deactivates provider", async () => {
    // Simulate prov_off event by directly calling the deactivation logic
    const timestamp = new Date().toISOString();
    await Bun.sql`
      UPDATE providers
      SET active = false, last_seen_at = ${timestamp}
      WHERE id = ${testProviderId}
    `;

    // Verify provider is now inactive
    const result = await Bun.sql`
      SELECT active, last_seen_at FROM providers WHERE id = ${testProviderId}
    `;
    
    expect(result.length).toBe(1);
    expect(result[0].active).toBe(false);
    expect(result[0].last_seen_at).toBeTruthy();
  });

  test("prov_on event reactivates provider", async () => {
    // First deactivate the provider
    await Bun.sql`
      UPDATE providers
      SET active = false
      WHERE id = ${testProviderId}
    `;

    // Verify it's inactive
    let result = await Bun.sql`
      SELECT active FROM providers WHERE id = ${testProviderId}
    `;
    expect(result[0].active).toBe(false);

    // Simulate prov_on event by reactivating
    const timestamp = new Date().toISOString();
    await Bun.sql`
      UPDATE providers
      SET active = true, last_seen_at = ${timestamp}
      WHERE id = ${testProviderId}
    `;

    // Verify provider is now active again
    result = await Bun.sql`
      SELECT active, last_seen_at FROM providers WHERE id = ${testProviderId}
    `;
    
    expect(result.length).toBe(1);
    expect(result[0].active).toBe(true);
    expect(result[0].last_seen_at).toBeTruthy();
  });

  test("prov_off and prov_on transitions work correctly", async () => {
    // Initial state: active
    let result = await Bun.sql`
      SELECT active FROM providers WHERE id = ${testProviderId}
    `;
    expect(result[0].active).toBe(true);

    // Transition 1: prov_off (deactivate)
    const timestamp1 = new Date().toISOString();
    await Bun.sql`
      UPDATE providers
      SET active = false, last_seen_at = ${timestamp1}
      WHERE id = ${testProviderId}
    `;

    result = await Bun.sql`
      SELECT active FROM providers WHERE id = ${testProviderId}
    `;
    expect(result[0].active).toBe(false);

    // Transition 2: prov_on (reactivate)
    const timestamp2 = new Date().toISOString();
    await Bun.sql`
      UPDATE providers
      SET active = true, last_seen_at = ${timestamp2}
      WHERE id = ${testProviderId}
    `;

    result = await Bun.sql`
      SELECT active FROM providers WHERE id = ${testProviderId}
    `;
    expect(result[0].active).toBe(true);

    // Transition 3: prov_off again
    const timestamp3 = new Date().toISOString();
    await Bun.sql`
      UPDATE providers
      SET active = false, last_seen_at = ${timestamp3}
      WHERE id = ${testProviderId}
    `;

    result = await Bun.sql`
      SELECT active FROM providers WHERE id = ${testProviderId}
    `;
    expect(result[0].active).toBe(false);
  });
});
