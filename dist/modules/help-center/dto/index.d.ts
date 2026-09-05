export declare class CreateFaqCategoryDto {
    slug: string;
    name: string;
    nameEn?: string;
    description?: string;
    descriptionEn?: string;
    icon?: string;
    sortOrder?: number;
}
export declare class UpdateFaqCategoryDto {
    slug?: string;
    name?: string;
    nameEn?: string;
    description?: string;
    descriptionEn?: string;
    icon?: string;
    sortOrder?: number;
    isActive?: boolean;
}
export declare class CreateFaqItemDto {
    categoryId: string;
    question: string;
    questionEn?: string;
    answer: string;
    answerEn?: string;
    sortOrder?: number;
}
export declare class UpdateFaqItemDto {
    categoryId?: string;
    question?: string;
    questionEn?: string;
    answer?: string;
    answerEn?: string;
    sortOrder?: number;
    isActive?: boolean;
}
