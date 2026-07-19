// src/core.ts

export type CircuitState = "CLOSED" | "OPEN" | "HALF-OPEN";

export interface CircuitConfig {
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

export interface CircuitStatus {
  state: CircuitState;
  failureCount: number;
  nextAttemptTime: number;
  activeRequests: number;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount: number = 0;
  private nextAttemptTime: number = 0;
  private activeRequests: number = 0; // Concurrency Counter ดักจับ Race Condition

  private readonly failureThreshold: number;
  private readonly cooldownPeriod: number;
  private readonly maxRetries: number;
  private readonly initialRetryDelay: number;
  private readonly isExpectedError?: (error: unknown) => boolean;

  private readonly listeners = new Set<
    (state: CircuitState, details: { failureCount: number }) => void
  >();

  // สำหรับให้ Dev ฝั่ง Frontend หรือ Logging ผูก Listener ดูสถานะระบบได้ (Backward Compatibility)
  public onStateChange?: (
    state: CircuitState,
    details: { failureCount: number },
  ) => void;

  public subscribe(
    listener: (state: CircuitState, details: { failureCount: number }) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  constructor(config: CircuitConfig) {
    if (config.failureThreshold <= 0)
      throw new Error("failureThreshold must be greater than 0");
    if (config.cooldownPeriod <= 0)
      throw new Error("cooldownPeriod must be greater than 0");

    this.failureThreshold = config.failureThreshold;
    this.cooldownPeriod = config.cooldownPeriod;
    this.maxRetries = config.maxRetries ?? 3;
    this.initialRetryDelay = config.initialRetryDelay ?? 500;
    this.isExpectedError = config.isExpectedError;
  }

  /**
   * 🚀 ฟังก์ชันหลักที่ครอบระบบความปลอดภัยและการจัดการ Request ทั่วทั้งระบบ
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.updateState();

    // 1. ตรวจสอบสภาพวงจร (Circuit Breaker Guard)
    if (this.state === "OPEN") {
      const remainingTime = Math.max(0, this.nextAttemptTime - Date.now());
      throw new Error(
        `🚨 [CircuitBreaker] Circuit is OPEN. Request blocked. Retry available in ${remainingTime}ms.`,
      );
    }

    // 2. ป้องกันข้ามสถานะขณะทดสอบระบบ (HALF-OPEN Concurrency Guard)
    // หากอยู่ในสถานะ HALF-OPEN ยอมให้หลุดเข้าไปทดสอบได้ทีละ 1 Request เท่านั้น ตัวที่มาทีหลังให้เด้งออกไปก่อน
    if (this.state === "HALF-OPEN" && this.activeRequests > 0) {
      throw new Error(
        `⏳ [CircuitBreaker] Circuit is HALF-OPEN and testing. Request throttled.`,
      );
    }

    this.activeRequests++;
    this.emitStateChange();
    let attempt = 0;

    try {
      while (true) {
        try {
          const result = await fn();
          this.onSuccess();
          return result;
        } catch (error) {
          // ตรวจสอบว่าเป็น Error ที่คาดเดาได้อยู่แล้วหรือไม่ (เช่น User พิมพ์รหัสผ่านผิด ไม่นับว่า Server พัง)
          if (this.isExpectedError && this.isExpectedError(error)) {
            throw error;
          }

          attempt++;

          // กลไกการทำ Retry จะเกิดขึ้นเฉพาะตอนสถานะ CLOSED เท่านั้น (HALF-OPEN ห้ามทำ Retry)
          if (attempt <= this.maxRetries && this.state === "CLOSED") {
            // สูตร Exponential Backoff + Full Jitter เพื่อกระจายโหลดไม่ให้ยิงพร้อมกันชุลมุน
            const backoffLimit =
              this.initialRetryDelay * Math.pow(2, attempt - 1);
            const jitteredDelay = Math.random() * backoffLimit;

            await this.sleep(jitteredDelay);
            continue;
          }

          // พยายามจนหมด หรือพังในสภาวะทดสอบระบบ ส่งไปสับคัตเอาท์ลง
          this.onFailure();
          throw error;
        }
      }
    } finally {
      this.activeRequests--;
      this.emitStateChange();
    }
  }

  public getStatus(): CircuitStatus {
    this.updateState();
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttemptTime: this.nextAttemptTime,
      activeRequests: this.activeRequests,
    };
  }

  private onSuccess() {
    const previousState = this.state;
    const previousFailureCount = this.failureCount;
    this.failureCount = 0;
    this.state = "CLOSED";

    if (previousState !== "CLOSED" || previousFailureCount > 0) {
      this.emitStateChange();
    }
  }

  private onFailure() {
    this.failureCount++;

    // ถ้าระบบพังตอนกำลังทดสอบ (HALF-OPEN) ให้สั่งปิดตายระบบทันที ไม่ต้องรอสะสมแต้มพัง
    if (
      this.state === "HALF-OPEN" ||
      this.failureCount >= this.failureThreshold
    ) {
      this.changeState("OPEN", Date.now() + this.cooldownPeriod);
    } else {
      this.emitStateChange();
    }
  }

  private updateState() {
    if (this.state === "OPEN" && Date.now() > this.nextAttemptTime) {
      this.changeState("HALF-OPEN", 0);
    }
  }

  private changeState(newState: CircuitState, nextAttemptTime: number) {
    this.state = newState;
    this.nextAttemptTime = nextAttemptTime;
    this.emitStateChange();
  }

  private emitStateChange() {
    if (this.onStateChange) {
      this.onStateChange(this.state, { failureCount: this.failureCount });
    }
    for (const listener of this.listeners) {
      listener(this.state, { failureCount: this.failureCount });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
