export declare class GetOrdersQueryDto {
    page: number;
    limit: number;
    status?: string;
    role?: 'BUYER' | 'SELLER' | 'ALL';
    search?: string;
}
