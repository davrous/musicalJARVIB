// Server-side Babylon.js code validation using NullEngine
// Mirrors the client scene setup so LLM-generated code can be tested before sending to clients

import * as BABYLON from "babylonjs";
import "babylonjs-loaders";

// Polyfill XMLHttpRequest for Node.js (required by Babylon.js loaders)
import xhr2 from "xhr2";
(global as any).XMLHttpRequest = xhr2;

let engine: BABYLON.NullEngine;
let scene: BABYLON.Scene;
let camera: BABYLON.ArcRotateCamera;
let light: BABYLON.HemisphericLight;
let trexindice = 0;

function getRandomNumber(): number {
  const max = 12;
  if (Math.random() < 0.5) {
    return Math.floor(Math.random() * (max - 3 + 1)) - max;
  } else {
    return Math.floor(Math.random() * (max - 3 + 1)) + 3;
  }
}

function initScene(): void {
  engine = new BABYLON.NullEngine({
    renderWidth: 512,
    renderHeight: 512,
    textureSize: 512,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });

  scene = new BABYLON.Scene(engine);

  camera = new BABYLON.ArcRotateCamera(
    "camera",
    -Math.PI / 2,
    Math.PI / 2.5,
    15,
    new BABYLON.Vector3(0, 0, 0),
    scene
  );
  camera.setTarget(BABYLON.Vector3.Zero());
  // Stub attachControl — it requires an HTML element which doesn't exist server-side
  camera.attachControl = (() => {}) as any;

  light = new BABYLON.HemisphericLight(
    "light",
    new BABYLON.Vector3(0, 1, 0),
    scene
  );
  light.intensity = 0.8;

  // Run a single render so the scene is fully initialized
  scene.render();
}

// Initialize on module load
initScene();

/**
 * Reset the validator scene — call this when the client scene is reset (e.g. /reset command).
 * Disposes the old scene and creates a fresh one so the server-side state matches the client.
 */
export function resetValidatorScene(): void {
  scene.dispose();
  trexindice = 0;
  initScene();
  console.log("[Validator] Scene reset");
}

/**
 * Validate Babylon.js code by executing it against the server-side NullEngine scene.
 * The scene is persistent — it accumulates state across calls, mirroring the client.
 * 
 * @returns { valid: true } if code executed without errors,
 *          { valid: false, error: string } if an error was caught.
 */
export async function validateBabylonCode(
  code: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Build a function that receives the same globals the client has
    const wrappedFn = new Function(
      "BABYLON",
      "scene",
      "engine",
      "camera",
      "light",
      "getRandomNumber",
      "trexindice",
      // Wrap in an async IIFE so .then() and await patterns work
      `return (async () => { ${code} })();`
    );

    await wrappedFn(
      BABYLON,
      scene,
      engine,
      camera,
      light,
      getRandomNumber,
      trexindice
    );

    // Render a frame to flush any deferred errors (e.g. bad material assignments)
    scene.render();

    console.log("[Validator] Code passed validation");
    return { valid: true };
  } catch (err: any) {
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    console.log(`[Validator] Code failed validation: ${errorMessage}`);
    return { valid: false, error: errorMessage };
  }
}
