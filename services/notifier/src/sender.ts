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
      throw new DeliveryError(false);
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
      this.blockedUntil = Date.now() + (delay ?? 30) * 1000;
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
      throw new DeliveryError(messageError, delay);
    }
  }
}
