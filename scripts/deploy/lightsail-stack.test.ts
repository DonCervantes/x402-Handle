import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("lightsail shared stack", () => {
  test("compose uses caddy with persisted tls state", () => {
    const compose = read("../../docker-compose.lightsail.yml");

    expect(compose).toContain("  caddy:\n");
    expect(compose).toContain("    image: caddy:2-alpine");
    expect(compose).toContain('      - "80:80"');
    expect(compose).toContain('      - "443:443"');
    expect(compose).toContain("      - ./deploy/caddy:/etc/caddy:ro");
    expect(compose).toContain("      - caddy_data:/data");
    expect(compose).toContain("      - caddy_config:/config");
    expect(compose).toContain("volumes:\n  caddy_data:\n  caddy_config:\n");
    expect(compose).not.toContain("  nginx:\n");
  });

  test("caddyfile routes both branches with stripped prefixes", () => {
    const caddyfile = read("../../deploy/caddy/Caddyfile");

    expect(caddyfile).toContain("(api_routes) {");
    expect(caddyfile).toContain("handle / {");
    expect(caddyfile).toContain('respond "{\\"branches\\":[\\"main\\",\\"develop\\"]}" 200');
    expect(caddyfile).toContain("redir /main /main/ 308");
    expect(caddyfile).toContain("handle_path /main/* {");
    expect(caddyfile).toContain("reverse_proxy main-bff-blue:3001 {");
    expect(caddyfile).toContain("header_up X-Forwarded-Prefix /main");
    expect(caddyfile).toContain("redir /develop /develop/ 308");
    expect(caddyfile).toContain("handle_path /develop/* {");
    expect(caddyfile).toContain("reverse_proxy develop-bff-blue:3001 {");
    expect(caddyfile).toContain("header_up X-Forwarded-Prefix /develop");
    expect(caddyfile).toContain('respond "not found" 404');
    expect(caddyfile).toContain("api.flovia402.com {");
    expect(caddyfile).toContain("import api_routes");
  });

  test("deployment sync provisions caddy stack assets without pruning images", () => {
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(syncScript).toContain('stack_caddy_dir="${stack_root}/deploy/caddy"');
    expect(syncScript).toContain('stack_caddy_config="${stack_caddy_dir}/Caddyfile"');
    expect(syncScript).toContain('install -m 644 deploy/caddy/Caddyfile "$stack_caddy_config"');
    expect(syncScript).toContain('dc pull "$next_service" caddy');
    expect(syncScript).toContain('dc up -d "$next_service"');
    expect(syncScript).toContain(
      "dc exec -T -w /etc/caddy caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile",
    );
    expect(syncScript).not.toContain("docker image prune -a -f");
    expect(syncScript).not.toContain("remove_old_bff_images");
    expect(syncScript).not.toContain("nginx");
  });

  test("caddy reload retries until the freshly recreated admin API is ready", () => {
    const syncScript = read("./lightsail-sync-stack.sh");

    // A freshly recreated caddy container does not have its admin API (port
    // 2019) listening the instant `dc up -d caddy` returns, so an immediate
    // reload races the startup and fails with "connection refused". The reload
    // must be wrapped in a bounded retry loop instead of being called directly.
    expect(syncScript).toContain("reload_caddy() {");
    expect(syncScript).toContain("reload_caddy");
    expect(syncScript.match(/dc up -d caddy\n\s*reload_caddy/)).not.toBeNull();
    // The retry loop owns the only direct reload invocation.
    expect(
      syncScript.split(
        "dc exec -T -w /etc/caddy caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile",
      ).length - 1,
    ).toBe(1);
    expect(syncScript).not.toContain("remove_old_bff_images");
    expect(syncScript).not.toContain("nginx");
  });

  test("deployment sync infers active develop slot from running containers", () => {
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(syncScript).not.toContain('slot_state_file="${stack_root}/.develop-bff-slot"');
    expect(syncScript).toContain("get_container_started_at()");
    expect(syncScript).toContain("detect_active_slot()");
    expect(syncScript).toContain("flovia-lightsail-develop-bff-blue-1");
    expect(syncScript).toContain("flovia-lightsail-develop-bff-green-1");
    expect(syncScript).toContain('blue_started_at="$(get_container_started_at');
    expect(syncScript).toContain('green_started_at="$(get_container_started_at');
    expect(syncScript).toContain(
      'detected_active_develop_slot="$(detect_active_slot develop "$develop_blue_container" "$develop_green_container")"',
    );
    expect(syncScript).toContain('active_slot="$detected_active"');
    expect(syncScript).toContain("next_slot");
    expect(syncScript).toContain('next_slot="blue"');
    expect(syncScript).toContain('next_slot="green"');
    expect(syncScript).toContain('next_service="${service_prefix}-${next_slot}"');
    expect(syncScript).toContain("wait_for_service_ready");
    expect(syncScript).toContain("local timeout_secs=600");
    expect(syncScript).toContain('ready_url="http://${container_ip}:3001/ready"');
    expect(syncScript).toContain('curl -sf --max-time "$request_timeout" "$ready_url"');
    expect(syncScript).toContain('grep -q \'"status":"ok"\'');
    expect(syncScript).toContain('grep -q \'"service":"flovia-bff"\'');
    expect(syncScript).toContain("Rolling back");
    expect(syncScript).toContain("write_caddyfile");
    expect(syncScript).toContain("caddy reload");
    expect(syncScript).toContain('dc stop "$old_service"');
    expect(syncScript).toContain('dc rm -f "$old_service"');
    expect(syncScript).not.toContain('printf \'%s\' "$next_slot" > "$slot_state_file"');
  });

  test("deployment passes live analytics database url to stack sync", () => {
    const workflow = read("../../.github/workflows/deploy-lightsail-shared.yml");

    expect(workflow).toContain("# - MAIN_BFF_ANALYTICS_DATABASE_URL");
    expect(workflow).toContain("# - DEVELOP_BFF_ANALYTICS_DATABASE_URL");
    expect(workflow).toContain("# - BFF_ANALYTICS_DATABASE_URL");
    expect(workflow).toContain("encode_env() {");
    expect(workflow).toContain("decode_env() {");
    expect(workflow).toContain(
      "MAIN_BFF_ANALYTICS_DATABASE_URL: ${{ secrets.MAIN_BFF_ANALYTICS_DATABASE_URL }}",
    );
    expect(workflow).toContain(
      "DEVELOP_BFF_ANALYTICS_DATABASE_URL: ${{ secrets.DEVELOP_BFF_ANALYTICS_DATABASE_URL }}",
    );
    expect(workflow).toContain(
      "BFF_ANALYTICS_DATABASE_URL: ${{ secrets.BFF_ANALYTICS_DATABASE_URL }}",
    );
    expect(workflow).toContain(
      'MAIN_BFF_ANALYTICS_DATABASE_URL_B64="${main_bff_analytics_database_url_b64}"',
    );
    expect(workflow).toContain(
      "decode_env MAIN_BFF_ANALYTICS_DATABASE_URL_B64 MAIN_BFF_ANALYTICS_DATABASE_URL",
    );
  });

  test("deployment sync writes analytics env for each branch", () => {
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(syncScript).toContain(
      'main_analytics_url="${MAIN_BFF_ANALYTICS_DATABASE_URL:-${BFF_ANALYTICS_DATABASE_URL:-}}"',
    );
    expect(syncScript).toContain(
      'develop_analytics_url="${DEVELOP_BFF_ANALYTICS_DATABASE_URL:-${BFF_ANALYTICS_DATABASE_URL:-}}"',
    );
    expect(syncScript).toContain("write_branch_analytics_env()");
    expect(syncScript).toContain("printf '%s_BFF_ANALYTICS_SOURCE=postgres");
    expect(syncScript).toContain("printf '%s_BFF_ANALYTICS_DATABASE_URL=%s");
    expect(syncScript).toContain("printf '%s_BFF_ANALYTICS_POSTGRES_MODE=snapshot");
    expect(syncScript).toContain('write_branch_analytics_env MAIN "$main_analytics_url"');
    expect(syncScript).toContain(
      'print_optional_env_var MAIN_BFF_ANALYTICS_READ_MODEL_PATH "${MAIN_BFF_ANALYTICS_READ_MODEL_PATH:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var MAIN_BFF_ANALYTICS_SNAPSHOT_ID "${MAIN_BFF_ANALYTICS_SNAPSHOT_ID:-}"',
    );
    expect(syncScript).toContain('write_branch_analytics_env DEVELOP "$develop_analytics_url"');
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_BFF_ANALYTICS_READ_MODEL_PATH "${DEVELOP_BFF_ANALYTICS_READ_MODEL_PATH:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_BFF_ANALYTICS_SNAPSHOT_ID "${DEVELOP_BFF_ANALYTICS_SNAPSHOT_ID:-}"',
    );
  });

  test("compose passes snapshot analytics postgres mode to both branches", () => {
    const compose = read("../../docker-compose.lightsail.yml");

    expect(compose).toContain(
      "BFF_ANALYTICS_POSTGRES_MODE: ${MAIN_BFF_ANALYTICS_POSTGRES_MODE:-snapshot}",
    );
    expect(compose).toContain(
      "BFF_ANALYTICS_POSTGRES_MODE: ${DEVELOP_BFF_ANALYTICS_POSTGRES_MODE:-snapshot}",
    );
    expect(compose).not.toContain("BFF_ANALYTICS_POSTGRES_MODE:-${BFF_ANALYTICS_POSTGRES_MODE");
  });

  test("compose bounds BFF containers so analytics OOM cannot hang the host", () => {
    const compose = read("../../docker-compose.lightsail.yml");

    expect(compose).toContain("x-bff-runtime-limits: &bff-runtime-limits");
    expect(compose).toContain("  cpus: ${BFF_CPUS:-1.5}");
    expect(compose).toContain("  mem_limit: ${BFF_MEMORY_LIMIT:-1500m}");
    expect(compose).toContain("  memswap_limit: ${BFF_MEMORY_SWAP_LIMIT:-2g}");
    expect(compose).toContain("  pids_limit: ${BFF_PIDS_LIMIT:-256}");
    expect(compose).toContain("  oom_kill_disable: false");
    expect(compose).toContain("  oom_score_adj: ${BFF_OOM_SCORE_ADJ:-500}");
    expect(compose).toContain("  init: true");
    expect(compose).toContain("x-main-bff: &main-bff\n  <<: *bff-runtime-limits");
    expect(compose).toContain("x-develop-bff: &develop-bff\n  <<: *bff-runtime-limits");
  });

  test("compose lets both branches share the common MPPX payer key", () => {
    const compose = read("../../docker-compose.lightsail.yml");

    expect(compose).toContain("MPPX_PRIVATE_KEY: ${MAIN_MPPX_PRIVATE_KEY:-${MPPX_PRIVATE_KEY:-}}");
    expect(compose).toContain(
      "MPPX_PRIVATE_KEY: ${DEVELOP_MPPX_PRIVATE_KEY:-${MPPX_PRIVATE_KEY:-}}",
    );
  });

  test("deployment passes common MPPX payer key to stack sync", () => {
    const workflow = read("../../.github/workflows/deploy-lightsail-shared.yml");
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(workflow).toContain("MPPX_PRIVATE_KEY: ${{ secrets.MPPX_PRIVATE_KEY }}");
    expect(workflow).toContain('mppx_private_key_b64="$(encode_env MPPX_PRIVATE_KEY)"');
    expect(workflow).toContain('MPPX_PRIVATE_KEY_B64="${mppx_private_key_b64}"');
    expect(workflow).toContain("decode_env MPPX_PRIVATE_KEY_B64 MPPX_PRIVATE_KEY");
    expect(syncScript).toContain('print_optional_env_var MPPX_PRIVATE_KEY "${MPPX_PRIVATE_KEY:-}"');
  });

  test("compose lets both branches share the common Stripe secret", () => {
    const compose = read("../../docker-compose.lightsail.yml");

    expect(compose).toContain(
      "STRIPE_SECRET_KEY: ${MAIN_STRIPE_SECRET_KEY:-${STRIPE_SECRET_KEY:-}}",
    );
    expect(compose).toContain(
      "STRIPE_SECRET_KEY: ${DEVELOP_STRIPE_SECRET_KEY:-${STRIPE_SECRET_KEY:-}}",
    );
  });

  test("deployment passes common Stripe secret to stack sync", () => {
    const workflow = read("../../.github/workflows/deploy-lightsail-shared.yml");
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(workflow).toContain("STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}");
    expect(workflow).toContain("MAIN_STRIPE_SECRET_KEY: ${{ secrets.MAIN_STRIPE_SECRET_KEY }}");
    expect(workflow).toContain('stripe_secret_key_b64="$(encode_env STRIPE_SECRET_KEY)"');
    expect(workflow).toContain('main_stripe_secret_key_b64="$(encode_env MAIN_STRIPE_SECRET_KEY)"');
    expect(workflow).toContain('STRIPE_SECRET_KEY_B64="${stripe_secret_key_b64}"');
    expect(workflow).toContain('MAIN_STRIPE_SECRET_KEY_B64="${main_stripe_secret_key_b64}"');
    expect(workflow).toContain("decode_env STRIPE_SECRET_KEY_B64 STRIPE_SECRET_KEY");
    expect(workflow).toContain("decode_env MAIN_STRIPE_SECRET_KEY_B64 MAIN_STRIPE_SECRET_KEY");
    expect(syncScript).toContain(
      'print_optional_env_var STRIPE_SECRET_KEY "${STRIPE_SECRET_KEY:-}"',
    );
  });

  test("deployment sync writes shared and branch-scoped payment secrets", () => {
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(syncScript).toContain('print_optional_env_var HITPAY_API_KEY "${HITPAY_API_KEY:-}"');
    expect(syncScript).toContain(
      'print_optional_env_var HITPAY_WEBHOOK_SALT "${HITPAY_WEBHOOK_SALT:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var HITPAY_MPP_ENDPOINT "${HITPAY_MPP_ENDPOINT:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var MAIN_HITPAY_API_KEY "${MAIN_HITPAY_API_KEY:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var MAIN_HITPAY_WEBHOOK_SALT "${MAIN_HITPAY_WEBHOOK_SALT:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var MAIN_HITPAY_MPP_ENDPOINT "${MAIN_HITPAY_MPP_ENDPOINT:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_HITPAY_API_KEY "${DEVELOP_HITPAY_API_KEY:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_HITPAY_WEBHOOK_SALT "${DEVELOP_HITPAY_WEBHOOK_SALT:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_HITPAY_MPP_ENDPOINT "${DEVELOP_HITPAY_MPP_ENDPOINT:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var MAIN_STRIPE_SECRET_KEY "${MAIN_STRIPE_SECRET_KEY:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_STRIPE_SECRET_KEY "${DEVELOP_STRIPE_SECRET_KEY:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_MPPX_PRIVATE_KEY "${DEVELOP_MPPX_PRIVATE_KEY:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_MPP_SECRET_KEY "${DEVELOP_MPP_SECRET_KEY:-}"',
    );
  });

  test("compose passes the optional LLM api key and quota env to both branches", () => {
    const compose = read("../../docker-compose.lightsail.yml");

    expect(compose).toContain("BFF_LLM_API_KEY: ${BFF_LLM_API_KEY:-}");
    expect(compose).toContain("BFF_LLM_QUOTA_MAX: ${BFF_LLM_QUOTA_MAX:-30}");
    expect(compose).toContain("BFF_LLM_QUOTA_WINDOW_MS: ${BFF_LLM_QUOTA_WINDOW_MS:-60000}");
  });

  test("deployment passes the optional LLM api key and quota env to stack sync", () => {
    const workflow = read("../../.github/workflows/deploy-lightsail-shared.yml");
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(workflow).toContain('BFF_LLM_API_KEY="${{ secrets.BFF_LLM_API_KEY }}"');
    expect(workflow).toContain('BFF_LLM_QUOTA_MAX="${{ secrets.BFF_LLM_QUOTA_MAX }}"');
    expect(workflow).toContain('BFF_LLM_QUOTA_WINDOW_MS="${{ secrets.BFF_LLM_QUOTA_WINDOW_MS }}"');
    expect(syncScript).toContain('print_optional_env_var BFF_LLM_API_KEY "${BFF_LLM_API_KEY:-}"');
    expect(syncScript).toContain(
      'print_optional_env_var BFF_LLM_QUOTA_MAX "${BFF_LLM_QUOTA_MAX:-}"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var BFF_LLM_QUOTA_WINDOW_MS "${BFF_LLM_QUOTA_WINDOW_MS:-}"',
    );
  });

  test("deployment auto-generates the x402 refresh token and passes it to stack sync", () => {
    const workflow = read("../../.github/workflows/deploy-lightsail-shared.yml");

    expect(workflow).toContain("- name: Generate x402 discovery refresh token");
    expect(workflow).toContain(
      'printf \'BFF_X402_REFRESH_TOKEN=%s\\n\' "$(openssl rand -hex 32)" >> "$GITHUB_ENV"',
    );
    expect(workflow).toContain('bff_x402_refresh_token_b64="$(encode_env BFF_X402_REFRESH_TOKEN)"');
    expect(workflow).toContain('BFF_X402_REFRESH_TOKEN_B64="${bff_x402_refresh_token_b64}"');
    expect(workflow).toContain(
      'BFF_X402_REFRESH_BASE_URL="${{ secrets.BFF_X402_REFRESH_BASE_URL }}"',
    );
    expect(workflow).toContain("decode_env BFF_X402_REFRESH_TOKEN_B64 BFF_X402_REFRESH_TOKEN");
    expect(workflow).toContain("export BFF_X402_REFRESH_TOKEN");
    expect(workflow).toContain("export BFF_X402_REFRESH_BASE_URL");
  });

  test("compose resolves the x402 refresh token per branch", () => {
    const compose = read("../../docker-compose.lightsail.yml");

    expect(compose).toContain(
      "BFF_X402_REFRESH_TOKEN: ${MAIN_BFF_X402_REFRESH_TOKEN:-${BFF_X402_REFRESH_TOKEN:-}}",
    );
    expect(compose).toContain(
      "BFF_X402_REFRESH_TOKEN: ${DEVELOP_BFF_X402_REFRESH_TOKEN:-${BFF_X402_REFRESH_TOKEN:-}}",
    );
  });

  test("deployment sync persists per-branch x402 tokens without clobbering the other branch", () => {
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(syncScript).toContain("resolve_x402_refresh_token() {");
    expect(syncScript).toContain("read_persisted_x402_refresh_token() {");
    expect(syncScript).toContain("generate_x402_refresh_token() {");
    expect(syncScript).toContain("openssl rand -hex 32");
    expect(syncScript).toContain('token_file="${secrets_dir}/x402-refresh-token"');
    expect(syncScript).toContain('chmod 600 "$token_file"');
    expect(syncScript).toContain(
      'main_x402_refresh_token="$(resolve_x402_refresh_token main "${BFF_X402_REFRESH_TOKEN:-}")"',
    );
    expect(syncScript).toContain(
      'develop_x402_refresh_token="$(read_persisted_x402_refresh_token develop)"',
    );
    expect(syncScript).toContain(
      'develop_x402_refresh_token="$(resolve_x402_refresh_token develop "${BFF_X402_REFRESH_TOKEN:-}")"',
    );
    expect(syncScript).toContain(
      'main_x402_refresh_token="$(read_persisted_x402_refresh_token main)"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var MAIN_BFF_X402_REFRESH_TOKEN "$main_x402_refresh_token"',
    );
    expect(syncScript).toContain(
      'print_optional_env_var DEVELOP_BFF_X402_REFRESH_TOKEN "$develop_x402_refresh_token"',
    );
  });

  test("deployment sync provisions an external cron that refreshes x402 twice a day", () => {
    const syncScript = read("./lightsail-sync-stack.sh");

    expect(syncScript).toContain("provision_x402_refresh_cron() {");
    expect(syncScript).toContain("install_x402_refresh_crontab() {");
    expect(syncScript).toContain(
      'x402_refresh_base_url="${BFF_X402_REFRESH_BASE_URL:-https://api.flovia402.com}"',
    );
    expect(syncScript).toContain(
      'refresh_url="${x402_refresh_base_url%/}/${branch}/aeo/x402/refresh"',
    );
    expect(syncScript).toContain('install -m 700 scripts/deploy/x402-refresh.sh "$script_path"');
    expect(syncScript).toContain('local env_path="${secrets_dir}/x402-refresh.env"');
    expect(syncScript).toContain("printf 'BFF_X402_REFRESH_URL=%s\\n' \"$refresh_url\"");
    expect(syncScript).toContain("printf 'BFF_X402_REFRESH_TOKEN=%s\\n' \"$token\"");
    expect(syncScript).toContain('chmod 600 "$env_path"');
    expect(syncScript).toContain('local begin_marker="# BEGIN flovia x402-refresh ${branch}"');
    expect(syncScript).toContain("printf 'CRON_TZ=UTC\\n'");
    expect(syncScript).toContain(
      'printf \'0 2 * * * /usr/bin/env bash %s %s >> %s 2>&1\\n\' "$script_path" "$env_path" "$log_path"',
    );
    expect(syncScript).toContain(
      'printf \'0 14 * * * /usr/bin/env bash %s %s >> %s 2>&1\\n\' "$script_path" "$env_path" "$log_path"',
    );
    expect(syncScript).toContain('provision_x402_refresh_cron main "$main_x402_refresh_token"');
    expect(syncScript).toContain(
      'provision_x402_refresh_cron develop "$develop_x402_refresh_token"',
    );
  });
});
