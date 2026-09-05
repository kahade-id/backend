import { PrismaService } from '../../prisma/prisma.service';
interface QuestionCreatedResponse {
    id: string;
    question: string;
    createdAt: Date;
}
interface AnswerResponse {
    id: string;
    answer: string;
    answeredAt: Date;
}
interface UserSummary {
    username: string | null;
    fullName: string | null;
    avatarUrl: string | null;
}
interface CommentResponse {
    id: string;
    content: string;
    parentId: string | null;
    author: UserSummary;
    createdAt: Date;
}
interface PaginatedQuestions {
    questions: Array<{
        id: string;
        content: string;
        answer: string | null;
        answeredAt: Date | null;
        askerUsername: string | null;
        asker: UserSummary | null;
        createdAt: Date;
        comments?: Array<{
            id: string;
            content: string;
            parentId: string | null;
            createdAt: Date;
            author: UserSummary;
        }>;
        commentCount: number;
        isPublic?: boolean;
        receiver?: UserSummary | null;
    }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}
interface PaginatedComments {
    data: CommentResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}
export declare class ProfileQAService {
    private prisma;
    constructor(prisma: PrismaService);
    askQuestion(askerId: string, receiverUsername: string, question: string): Promise<QuestionCreatedResponse>;
    answerQuestion(userId: string, questionId: string, answer: string): Promise<AnswerResponse>;
    private readonly commentSelect;
    getProfileQuestions(username: string, page: number, limit: number): Promise<PaginatedQuestions>;
    getMyQuestions(userId: string, type: 'received' | 'asked', page: number, limit: number): Promise<PaginatedQuestions>;
    addComment(userId: string, questionId: string, content: string, parentId?: string): Promise<CommentResponse>;
    getComments(questionId: string, page: number, limit: number): Promise<PaginatedComments>;
    deleteComment(userId: string, commentId: string): Promise<{
        message: string;
    }>;
    deleteQuestion(userId: string, questionId: string): Promise<{
        message: string;
    }>;
}
export {};
