export declare enum UserChatMessageType {
    TEXT = "TEXT",
    IMAGE = "IMAGE",
    FILE = "FILE"
}
export declare class ChatAttachmentDto {
    fileName: string;
    fileUrl: string;
    mimeType: string;
    thumbnailUrl?: string;
    fileSize: number;
}
export declare class SendMessageDto {
    messageType?: UserChatMessageType;
    content?: string;
    attachments?: ChatAttachmentDto[];
    replyToId?: string;
}
