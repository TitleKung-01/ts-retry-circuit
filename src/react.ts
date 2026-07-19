// src/react.ts
import { useState, useEffect, useCallback, useRef } from "react";
import { CircuitBreaker, CircuitConfig, CircuitState } from "./core.js";

export interface UseCircuitBreakerOptions extends CircuitConfig {
  /** คีย์สสำหรับผูกอินสแตนซ์ข้ามคอมโพเนนต์ (ช่วยแชร์สเตตัสร่วมกันในแอป) */
  instanceKey?: string;
}

export interface UseCircuitBreakerResult {
  /** สถานะปัจจุบันของวงจร ('CLOSED' | 'OPEN' | 'HALF-OPEN') */
  state: CircuitState;
  /** จำนวนครั้งที่พังสะสม ณ ปัจจุบัน */
  failureCount: number;
  /** จำนวน Request ที่กำลังทำงานอยู่พร้อมๆ กันใน Hook นี้ */
  activeRequests: number;
  /** สั่งรันฟังก์ชันผ่าน Circuit Breaker */
  execute: <T>(fn: () => Promise<T>) => Promise<T>;
  /** ตัวชี้วัดว่าระบบสับคัตเอาท์ลงแล้วหรือยัง เพื่อเอาไปใช้ Disabled ปุ่มกดบนหน้าเว็บ */
  isOpened: boolean;
}

// Global registry สำหรับแชร์ Circuit Breaker อินสแตนซ์เดียวกันในกรณีที่ใช้ key เดียวกัน
const breakerRegistry = new Map<string, CircuitBreaker>();

export function useCircuitBreaker(
  options: UseCircuitBreakerOptions,
): UseCircuitBreakerResult {
  const {
    failureThreshold,
    cooldownPeriod,
    maxRetries,
    initialRetryDelay,
    isExpectedError,
    instanceKey,
  } = options;

  // 1. ใช้ useRef ถือตัวอินสแตนซ์ CircuitBreaker ไว้ไม่ให้เปลี่ยนตามการ Re-render
  const breakerRef = useRef<CircuitBreaker | null>(null);

  // 2. สร้างสเตตัสภายใน React เพื่อคอยอัปเดต UI ให้ Sync กับสถานะวงจรข้างใน
  const [circuitState, setCircuitState] = useState<CircuitState>("CLOSED");
  const [metrics, setMetrics] = useState({
    failureCount: 0,
    activeRequests: 0,
  });

  // 3. เริ่มต้นสร้างหรือดึงอินสแตนซ์มาใช้งาน (รองรับทั้ง Single Component และ Shared State)
  if (!breakerRef.current) {
    if (instanceKey) {
      if (!breakerRegistry.has(instanceKey)) {
        breakerRegistry.set(
          instanceKey,
          new CircuitBreaker({
            failureThreshold,
            cooldownPeriod,
            maxRetries,
            initialRetryDelay,
            isExpectedError,
          }),
        );
      }
      breakerRef.current = breakerRegistry.get(instanceKey)!;
    } else {
      breakerRef.current = new CircuitBreaker({
        failureThreshold,
        cooldownPeriod,
        maxRetries,
        initialRetryDelay,
        isExpectedError,
      });
    }
  }

  // 4. ผูก Event Listener เมื่อสถานะข้างในคลาสเปลี่ยน ให้มาสั่ง SetState ฝั่ง React ด้วย
  useEffect(() => {
    const breaker = breakerRef.current;
    if (!breaker) return;

    // ซิงค์สเตตัสเริ่มต้นก่อน
    const currentStatus = breaker.getStatus();
    setCircuitState(currentStatus.state);
    setMetrics({
      failureCount: currentStatus.failureCount,
      activeRequests: currentStatus.activeRequests,
    });

    // สมัครรับข้อมูลการเปลี่ยนแปลงสเตตัส (รองรับระบบ Pub/Sub สำหรับ Shared Instances)
    const unsubscribe = breaker.subscribe((newState, details) => {
      setCircuitState(newState);
      setMetrics({
        failureCount: details.failureCount,
        activeRequests: breaker.getStatus().activeRequests,
      });
    });

    // คืนค่าฟังก์ชันเพื่อเคลียร์ Listener ป้องกัน Memory Leak
    return () => {
      unsubscribe();
    };
  }, [instanceKey]);

  /**
   * ⚡ ฟังก์ชันสำหรับสั่งรัน API หรือการทำงานอื่น ๆ ผ่านระเบียงความปลอดภัยของ Circuit Breaker
   */
  const execute = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    const breaker = breakerRef.current;
    if (!breaker) {
      throw new Error(
        "[useCircuitBreaker] CircuitBreaker instance is not initialized.",
      );
    }
    return breaker.execute(fn);
  }, []);

  return {
    /** สถานะปัจจุบันของวงจร ('CLOSED' | 'OPEN' | 'HALF-OPEN') */
    state: circuitState,
    /** จำนวนครั้งที่พังสะสม ณ ปัจจุบัน */
    failureCount: metrics.failureCount,
    /** จำนวน Request ที่กำลังทำงานอยู่พร้อมๆ กันใน Hook นี้ */
    activeRequests: metrics.activeRequests,
    /** สั่งรันฟังก์ชันผ่าน Circuit Breaker */
    execute,
    /** ตัวชี้วัดว่าระบบสับคัตเอาท์ลงแล้วหรือยัง เพื่อเอาไปใช้ Disabled ปุ่มกดบนหน้าเว็บ */
    isOpened: circuitState === "OPEN",
  };
}
