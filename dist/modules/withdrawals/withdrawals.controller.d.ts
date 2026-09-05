import { ScheduledWithdrawalService } from './scheduled-withdrawal.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
export declare class WithdrawalsController {
    private scheduledWithdrawalService;
    constructor(scheduledWithdrawalService: ScheduledWithdrawalService);
    createSchedule(userId: string, dto: CreateScheduleDto): Promise<object>;
    getSchedules(userId: string): Promise<object[]>;
    updateSchedule(userId: string, scheduleId: string, dto: UpdateScheduleDto): Promise<object>;
    deleteSchedule(userId: string, scheduleId: string): Promise<{
        message: string;
    }>;
}
