export interface Sender {
  send(text: string): Promise<void>;
}
export class DeliveryError extends Error {
  constructor(
    readonly permanent: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super('Delivery failed');
  }
}
export class TelegramSender implements Sender {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}
  async send(text: string) {
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
    } | null;
    if (!response.ok || body?.ok !== true) {
      throw new DeliveryError(
        response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429,
        body?.parameters?.retry_after,
      );
    }
  }
}
