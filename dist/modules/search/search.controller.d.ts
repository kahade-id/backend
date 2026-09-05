import { SearchService } from './search.service';
export declare class SearchController {
    private searchService;
    constructor(searchService: SearchService);
    search(userId: string, query: string, types?: string, limitParam?: string): Promise<object>;
    suggestions(userId: string, query: string, limitParam?: string): Promise<object>;
}
