export declare enum DateRangePreset {
    TODAY = "today",
    YESTERDAY = "yesterday",
    LAST_7_DAYS = "last_7_days",
    LAST_30_DAYS = "last_30_days",
    THIS_MONTH = "this_month",
    LAST_MONTH = "last_month",
    CUSTOM = "custom"
}
export declare class DateRangeDto {
    preset?: DateRangePreset;
    startDate?: string;
    endDate?: string;
}
export declare function getDateRangeFromPreset(preset: DateRangePreset): {
    startDate: Date;
    endDate: Date;
};
