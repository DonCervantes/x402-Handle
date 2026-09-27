// packages/agent-sdk/src/policy.ts
//
// Guard rails de pago del lado agente.
//
// Un provider del registry Soroban es una identidad on-chain (`owner`) más un
// endpoint HTTP que el provider controla. El endpoint es lo único que el agente
// no puede verificar on-chain, así que es exactamente donde un provider
// registrado puede intentar desviar el USDC: cambiando el `destination` del
// challenge, o sirviendo desde un host/red que el agente no esperaba.
//
// Este módulo decide qué endpoints merecen que se les pida un challenge. El
// binding del destino se aplica dentro de `x402Pay` (`expectedDestination`),
// porque la comprobación tiene que ocurrir entre el challenge recibido y la
// firma de la transacción.

export type EndpointPolicy = {
  /**
   * Allowlist de hosts aceptados. Si está presente, sólo los endpoints cuyo
   * host matchee alguna entrada pueden pagarse. Se admiten comodines de
   * subdominio (`*.example.com` matchea `api.example.com` pero no
   * `example.com`). Vacío/ausente = cualquier host que cumpla el resto.
   */
  allowedHosts?: readonly string[];
  /**
   * Permite endpoints `http://` (desarrollo local). Default: `false` — el
   * agente firma pagos, y un challenge servido por un transporte en claro es
   * manipulable por cualquiera en la ruta.
   */
  allowInsecure?: boolean;
};

/** `true` si `host` (sin puerto, minúsculas) matchea el patrón de la allowlist. */
export function matchesHost(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

/**
 * Valida el endpoint de pago de un provider y devuelve la URL parseada.
 * Lanza si el endpoint no es una URL válida, no es HTTPS (salvo opt-in
 * explícito) o su host queda fuera de la allowlist.
 */
export function assertPaymentEndpointAllowed(endpoint: string, policy: EndpointPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Flovia: provider endpoint is not a valid URL: ${endpoint}`);
  }

  if (url.protocol !== "https:" && !policy.allowInsecure) {
    throw new Error(
      `Flovia: refusing to pay a non-HTTPS provider endpoint (${url.protocol}//${url.host}); ` +
        "pass allowInsecureEndpoint: true only for local development",
    );
  }

  const allowedHosts = policy.allowedHosts ?? [];
  if (
    allowedHosts.length > 0 &&
    !allowedHosts.some((pattern) => matchesHost(url.hostname, pattern))
  ) {
    throw new Error(
      `Flovia: provider endpoint host "${url.hostname}" is not in the allowed hosts ` +
        `[${allowedHosts.join(", ")}]`,
    );
  }

  return url;
}

/**
 * Cuenta de pago declarada por el registry para este provider.
 *
 * Es la única fuente de verdad del destino que el agente acepta: si el
 * registry no la expone, el pago se aborta en lugar de confiar en el
 * `destination` que devuelva el endpoint.
 */
export function registryPaymentAccount(provider: { ownerAccount?: string }): string {
  const owner = provider.ownerAccount?.trim();
  if (!owner) {
    throw new Error(
      "Flovia: provider has no registry ownerAccount — refusing to pay without a destination to bind to",
    );
  }
  return owner;
}
