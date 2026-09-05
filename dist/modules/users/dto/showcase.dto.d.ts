export declare class CreateShowcaseDto {
    title: string;
    description?: string;
    imageUrl?: string;
    priceMin?: number;
    priceMax?: number;
    sortOrder?: number;
}
export declare class UpdateShowcaseDto {
    title?: string;
    description?: string;
    imageUrl?: string;
    priceMin?: number;
    priceMax?: number;
    isActive?: boolean;
    sortOrder?: number;
}
