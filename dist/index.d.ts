type CircuitState = "CLOSED" | "OPEN" | "HALF-OPEN";
interface CircuitConfig {
    /** พังติดต่อกันกี่ครั้งถึงจะสั่งตัดวงจร (สับคัตเอาท์เป็น OPEN) */
    failureThreshold: number;
    /** เวลาที่ต้องรอ (มิลลิวินาที) ก่อนที่จะลองเปิดใจใหม่อีกครั้งในสถานะ HALF-OPEN */
    cooldownPeriod: number;
    /** จำนวนครั้งสูงสุดที่จะพยายามลองยิงซ้ำ (Retry) ใหม่ก่อนจะยอมแพ้ */
    maxRetries?: number;
    /** เวลาเริ่มต้นในการหน่วงเพื่อรอ Retry ใหม่ (มิลลิวินาที) */
    initialRetryDelay?: number;
    /** ฟังก์ชันกรอง Error: ตัวแปรไหนเจอแล้วไม่ต้องนับเป็นความพังของระบบ (เช่น 401 Unauthorized, 404 Not Found) */
    isExpectedError?: (error: unknown) => boolean;
}
interface CircuitStatus {
    state: CircuitState;
    failureCount: number;
    nextAttemptTime: number;
    activeRequests: number;
}
declare class CircuitBreaker {
    private state;
    private failureCount;
    private nextAttemptTime;
    private activeRequests;
    private readonly failureThreshold;
    private readonly cooldownPeriod;
    private readonly maxRetries;
    private readonly initialRetryDelay;
    private readonly isExpectedError?;
    onStateChange?: (state: CircuitState, details: {
        failureCount: number;
    }) => void;
    constructor(config: CircuitConfig);
    /**
     * 🚀 ฟังก์ชันหลักที่ครอบระบบความปลอดภัยและการจัดการ Request ทั่วทั้งระบบ
     */
    execute<T>(fn: () => Promise<T>): Promise<T>;
    getStatus(): CircuitStatus;
    private onSuccess;
    private onFailure;
    private updateState;
    private changeState;
    private emitStateChange;
    private sleep;
}

export { CircuitBreaker, type CircuitConfig, type CircuitState, type CircuitStatus };
