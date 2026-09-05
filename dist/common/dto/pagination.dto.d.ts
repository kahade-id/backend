export declare class PaginationDto {
    page?: number;
    limit?: number;
}
export interface PaginatedResponse<T> {
    data: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
}
export declare function createPaginatedResponse<T>(data: T[], total: number, page: number, limit: number): PaginatedResponse<T>;
