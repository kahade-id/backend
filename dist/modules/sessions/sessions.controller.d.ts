import { SessionsService } from './sessions.service';
export declare class SessionsController {
    private sessionsService;
    constructor(sessionsService: SessionsService);
    getActiveSessions(userId: string, currentSessionId: string, page: number, limit: number): Promise<{
        sessions: Array<Record<string, unknown>>;
        total: number;
        page: number;
        limit: number;
    }>;
    revokeAllOtherSessions(userId: string, currentSessionId: string): Promise<{
        count: number;
    }>;
    revokeSession(userId: string, sessionId: string): Promise<{
        message: string;
    }>;
}
