declare module 'three/examples/jsm/controls/OrbitControls' {
  import { Camera, MOUSE, Object3D, Vector3, EventDispatcher } from 'three';
  export class OrbitControls extends EventDispatcher {
    constructor(object: Camera, domElement?: HTMLElement);
    object: Camera;
    domElement: HTMLElement;
    enabled: boolean;
    target: Vector3;
    minDistance: number;
    maxDistance: number;
    enableDamping: boolean;
    dampingFactor: number;
    enablePan: boolean;
    enableZoom: boolean;
    update(): void;
    dispose(): void;
  }
}
