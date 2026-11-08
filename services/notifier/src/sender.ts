export interface Sender {
  send(text: string, parseMode?: 'HTML'): Promise<void>;
  isReady?(): boolean;
}
export class DeliveryError extends Error {
  constructor(
    readonly permanent: boolean,
    readonly retryAfterSeconds?: number,
    readonly blocked = false,
  ) {
    super('Delivery failed');
  }
}
export class TelegramSender implements Sender {
  private blockedUntil = 0;
  private configurationBlocked = false;
  private failures = 0;
  private pause(seconds?: number) {
    const delay =
      seconds ?? Math.min(900, 30 * 2 ** Math.min(this.failures, 5));
    this.failures++;
    this.blockedUntil = Date.now() + delay * 1000;
    return delay;
  }
  isReady() {
    return !this.configurationBlocked && Date.now() >= this.blockedUntil;
  }
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}
  async send(text: string, parseMode?: 'HTML') {
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: parseMode,
            link_preview_options: { is_disabled: true },
          }),
        },
      );
    } catch {
      throw new DeliveryError(false, this.pause(), true);
    }
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      parameters?: { retry_after?: number };
      description?: string;
    } | null;
    const rawDelay = body?.parameters?.retry_after;
    const delay =
      typeof rawDelay === 'number' && Number.isFinite(rawDelay)
        ? Math.max(1, Math.min(86400, Math.ceil(rawDelay)))
        : undefined;
    if (response.status === 429)
      throw new DeliveryError(false, this.pause(delay ?? 30), true);
    if (!response.ok || body?.ok !== true) {
      const messageError =
        response.status === 400 &&
        typeof body?.description === 'string' &&
        /message is too long|message text is empty|can't parse entities/i.test(
          body.description,
        );
      if (
        response.status === 404 ||
        response.status === 401 ||
        response.status === 403 ||
        (response.status === 400 && !messageError)
      ) {
        this.configurationBlocked = true;
        throw new DeliveryError(false, undefined, true);
      }
      if (messageError) throw new DeliveryError(true);
      throw new DeliveryError(false, this.pause(delay), true);
    }
    this.failures = 0;
  }
}
