export interface TelegramUser { id: number; }
export interface TelegramChat { id: number; type: string; }
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  reply_to_message?: TelegramMessage;
}
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface InlineButton { text: string; callback_data: string; }

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(token: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const payload = await response.json() as TelegramResponse<T>;
    if (!response.ok || !payload.ok || payload.result === undefined) {
      const error = new Error(`Telegram ${method} failed: ${payload.description ?? response.statusText}`) as Error & { retryAfter?: number; code?: number };
      if (payload.parameters?.retry_after !== undefined) error.retryAfter = payload.parameters.retry_after;
      if (payload.error_code !== undefined) error.code = payload.error_code;
      throw error;
    }
    return payload.result;
  }

  getUpdates(offset: number, timeoutSeconds = 25, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    }, signal);
  }

  sendMessage(
    chatId: string | number,
    text: string,
    buttons?: InlineButton[][],
    forceReply = false,
    replyToMessageId?: number,
  ): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyToMessageId !== undefined ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {}),
      ...(buttons && buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : forceReply ? { reply_markup: { force_reply: true } } : {}),
    });
  }

  sendForceReply(
    chatId: string | number,
    text: string,
    replyToMessageId?: number,
    placeholder?: string,
  ): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyToMessageId !== undefined ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {}),
      reply_markup: {
        force_reply: true,
        selective: true,
        ...(placeholder ? { input_field_placeholder: placeholder.slice(0, 64) } : {}),
      },
    });
  }

  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    buttons?: InlineButton[][],
  ): Promise<TelegramMessage> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  editMessageReplyMarkup(chatId: string | number, messageId: number, buttons: InlineButton[][] = []): Promise<unknown> {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<true> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  setMyCommands(commands: BotCommand[], signal?: AbortSignal): Promise<boolean> {
    return this.call("setMyCommands", { commands }, signal);
  }
}
