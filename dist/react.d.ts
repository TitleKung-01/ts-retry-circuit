import { CircuitConfig, CircuitState } from './index.js';

interface UseCircuitBreakerOptions extends CircuitConfig {
    /** คีย์สสำหรับผูกอินสแตนซ์ข้ามคอมโพเนนต์ (ช่วยแชร์สเตตัสร่วมกันในแอป) */
    instanceKey?: string;
}
interface UseCircuitBreakerResult {
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
declare function useCircuitBreaker(options: UseCircuitBreakerOptions): UseCircuitBreakerResult;

export { type UseCircuitBreakerOptions, type UseCircuitBreakerResult, useCircuitBreaker };
