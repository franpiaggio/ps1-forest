// Post-processing pipeline for v06 — same HDR / in-composer tone-mapping
// shape as v05, with a GodraysPass slotted in between the RenderPass and the
// main effect chain.
//
// Order rationale:
//
//   1. RenderPass        →  raw HDR scene
//   2. GodraysPass       →  reads HDR + shadow map, adds volumetric rays in
//                           linear space, output still HDR. gammaCorrection is
//                           disabled because the pipeline's ToneMappingEffect
//                           later does the linear→display conversion exactly
//                           once; turning godrays gamma on would double-encode.
//   3. Main EffectPass   →  Bloom (picks up bright ray peaks → glow), DoF
//                           (softens distant rays for depth), ToneMappingEffect
//                           (ACES_FILMIC), HueSat, Brightness/Contrast,
//                           Vignette, SMAA.
//   4. ChromaticAberration — own pass (vertex shader, won't merge). Disabled
//                            in all v06 tiers.

import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  SMAAEffect,
  SMAAPreset,
  EdgeDetectionMode,
  BloomEffect,
  KernelSize,
  DepthOfFieldEffect,
  VignetteEffect,
  HueSaturationEffect,
  BrightnessContrastEffect,
  NoiseEffect,
  ChromaticAberrationEffect,
  ToneMappingEffect,
  ToneMappingMode,
  BlendFunction,
} from 'postprocessing';
import { GodraysPass } from 'three-good-godrays';
import { PS1Effect } from './ps1.js';

const SMAA_LOOKUP = {
  LOW:    SMAAPreset.LOW,
  MEDIUM: SMAAPreset.MEDIUM,
  HIGH:   SMAAPreset.HIGH,
  ULTRA:  SMAAPreset.ULTRA,
};
const KERNEL_LOOKUP = {
  VERY_SMALL: KernelSize.VERY_SMALL,
  SMALL:      KernelSize.SMALL,
  MEDIUM:     KernelSize.MEDIUM,
  LARGE:      KernelSize.LARGE,
  HUGE:       KernelSize.HUGE,
};

export function buildPipeline(renderer, scene, camera, preset, light) {
  renderer.toneMapping = THREE.NoToneMapping;

  const composer = new EffectComposer(renderer, {
    frameBufferType: preset.halfFloatHDR ? THREE.HalfFloatType : THREE.UnsignedByteType,
  });

  composer.addPass(new RenderPass(scene, camera));

  // ── Godrays ──────────────────────────────────────────────────────────────
  let godrays = null;
  if (preset.godraysEnabled && light && light.castShadow) {
    godrays = new GodraysPass(light, camera, {
      color:               new THREE.Color(preset.godraysColor ?? 0xffe6bf),
      density:             preset.godraysDensity        ?? 1 / 128,
      maxDensity:          preset.godraysMaxDensity     ?? 0.5,
      distanceAttenuation: preset.godraysDistanceAtten  ?? 1.0,
      raymarchSteps:       preset.godraysRaymarchSteps  ?? 60,
      blur:                preset.godraysBlur           ?? true,
      // Stay in linear HDR; ToneMappingEffect does the single final encoding.
      gammaCorrection:     false,
    });
    composer.addPass(godrays);
  }

  // ── Main effect chain (mergeable into one EffectPass) ────────────────────
  const bloom = preset.bloomEnabled ? new BloomEffect({
    intensity:          preset.bloomIntensity ?? 0.2,
    luminanceThreshold: preset.bloomThreshold ?? 0.92,
    luminanceSmoothing: preset.bloomSmoothing ?? 0.15,
    kernelSize:         KERNEL_LOOKUP[preset.bloomKernel] ?? KernelSize.MEDIUM,
    mipmapBlur:         true,
  }) : null;

  const dof = preset.dofEnabled ? new DepthOfFieldEffect(camera, {
    focusDistance:   9,
    focusRange:      14,
    bokehScale:      preset.dofBokehScale ?? 2.0,
    resolutionScale: preset.dofResScale   ?? 0.5,
  }) : null;

  // LINEAR (raw + clamp), the way PS1 actually output: no filmic curve to wash or
  // darken anything. Filmic curves (ACES/NEUTRAL) either burn the highlights or
  // crush the mids here. Lights are pulled down in main.js so the clamp doesn't
  // blow grass/sky to white — vivid LDR, the PS1 read.
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.LINEAR });
  const hueSat = new HueSaturationEffect({ saturation: preset.ps1Saturation ?? 0.16 });
  const brightnessContrast = new BrightnessContrastEffect({ brightness: 0.0, contrast: 0.05 });
  const vignette = new VignetteEffect({
    eskil:    false,
    offset:   preset.vignetteOffset ?? 0.30,
    darkness: Math.min(0.36, preset.vignetteDarkness ?? 0.5),   // gentler corners
  });
  const smaa = preset.smaaEnabled === false ? null : new SMAAEffect({
    preset:            SMAA_LOOKUP[preset.smaaPreset] ?? SMAAPreset.MEDIUM,
    edgeDetectionMode: EdgeDetectionMode.COLOR,
  });

  // PS1 quantise + ordered dither — LAST, so it acts on the final tone-mapped
  // image (15-bit colour + the signature grain).
  const ps1 = new PS1Effect({ levels: preset.ps1Levels ?? 56, dither: preset.ps1Dither ?? 0 });

  const effects = [bloom, dof, toneMapping, hueSat, brightnessContrast, vignette, smaa, ps1]
    .filter(Boolean);
  composer.addPass(new EffectPass(camera, ...effects));

  if (preset.chromAbEnabled) {
    composer.addPass(new EffectPass(camera, new ChromaticAberrationEffect({
      offset: new THREE.Vector2(
        preset.chromAbOffset?.[0] ?? 0.0006,
        preset.chromAbOffset?.[1] ?? 0.0003,
      ),
      radialModulation: true,
      modulationOffset: 0.25,
    })));
  }

  function resize() {
    // Match the renderer's (low-res PS1) drawing buffer, NOT the CSS size — the
    // canvas is sized small with updateStyle:false and CSS-upscaled.
    const s = renderer.getSize(new THREE.Vector2());
    composer.setSize(s.x, s.y);
  }

  function setFocusTarget(worldDist) {
    if (dof) dof.cocMaterial.focusDistance = Math.max(1, worldDist);
  }

  return {
    composer, resize, setFocusTarget, godrays,
    effects: { bloom, dof, toneMapping, hueSat, brightnessContrast, vignette, ps1 },
  };
}
