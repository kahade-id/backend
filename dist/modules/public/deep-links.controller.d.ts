import type { Response } from 'express';
import { UsersService } from '../users/users.service';
import { OrderLinksService } from '../orders/order-links.service';
export declare class DeepLinksController {
    private readonly usersService;
    private readonly orderLinksService;
    constructor(usersService: UsersService, orderLinksService: OrderLinksService);
    profile(username: string, response: Response): Promise<void>;
    profileAlias(username: string, response: Response): Promise<void>;
    orderLink(token: string, response: Response): Promise<void>;
    order(orderId: string, response: Response): void;
    notification(notificationId: string, response: Response): void;
}
