export interface TelegramIdentity {
  userId: string;
  chatId: string;
}

export function isAuthorized(identity: TelegramIdentity, allowedUserId: string, allowedChatId: string): boolean {
  return identity.userId === allowedUserId && identity.chatId === allowedChatId;
}
