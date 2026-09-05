export declare class UserLinkItemDto {
    platform: string;
    url: string;
    label?: string;
    displayOrder?: number;
}
export declare class UpdateLinksDto {
    links: UserLinkItemDto[];
}
