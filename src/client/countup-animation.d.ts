declare module 'countup-animation' {
  export default function animateCountUp(
    element: HTMLElement,
    duration: number,
    stepSize: number | null,
    startingValue: number | null,
    onAnimationComplete?: () => void,
  ): void;
}
