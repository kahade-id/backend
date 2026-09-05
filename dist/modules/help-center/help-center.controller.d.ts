import { HelpCenterService } from './help-center.service';
export declare class HelpCenterController {
    private helpCenterService;
    constructor(helpCenterService: HelpCenterService);
    getCategories(lang?: string): Promise<{
        id: string;
        slug: string;
        name: string;
        description: string | null;
        icon: string | null;
        items: {
            id: string;
            question: string;
            answer: string;
            viewCount: number;
        }[];
    }[]>;
    getCategoryBySlug(slug: string, lang?: string): Promise<{
        id: string;
        slug: string;
        name: string;
        description: string | null;
        icon: string | null;
        items: {
            id: string;
            question: string;
            answer: string;
            viewCount: number;
        }[];
    }>;
    searchFaq(query: string, lang?: string): Promise<{
        id: string;
        question: string;
        answer: string;
        viewCount: number;
        category: {
            slug: string;
            name: string;
        };
    }[]>;
    trackView(id: string): Promise<void>;
}
