// @vitest-environment node
/**
 * SPIKE — A/B of the current SoundTouch worklet pipeline against Signalsmith
 * Stretch, offline, on the settings that reach a worklet (a transpose, optionally
 * with a tempo: the element resamples raw at `tempo`, the worklet compensates).
 *
 * Writes a Markdown table to `spike/RESULTS.md`. Metrics:
 *  - latency: output onset after a tone starts (ms) — how far audio trails video
 *  - purity: harmonic-to-residual energy of a steady tone / triad (dB, higher =
 *    cleaner: aliasing, phasiness and splice artifacts all land in the residual)
 *  - smear: share of a click's energy outside [-3, +15] ms of its peak (%, lower =
 *    sharper transients)
 *  - cpu: mean / p99 / max time per 128-frame quantum (µs; budget ≈ 2667 µs)
 */
import { writeFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { drive, pacedPipe, pipePitch } from '@/lib/testing/pipeSim'

import { QUANTUM, SR, createStretch, type StretchConfig } from './signalsmithSim'

const SECONDS = 3
const QUANTA = Math.round((SR * SECONDS) / QUANTUM)

type Engine = {
	name: string
	run(semitones: number, tempo: number, input: (t: number) => number): Promise<Run>
}
type Run = { out: Float32Array; cpu: number[] }

const soundtouch: Engine = {
	name: 'SoundTouch (current)',
	async run(semitones, tempo, input) {
		// pipeSim records no timing; time the same loop by hand around `drive`.
		const t0 = performance.now()
		const { out } = drive(pacedPipe(), () => pipePitch(semitones, tempo), SECONDS, input)
		const total = performance.now() - t0
		// Per-quantum timing for the paced pipe, measured separately below.
		return {
			out: Float32Array.from(out),
			cpu: perQuantumSoundTouch(semitones, tempo, input, total),
		}
	},
}

/** Re-run SoundTouch quantum by quantum with timing (drive() has no hooks). */
function perQuantumSoundTouch(
	semitones: number,
	tempo: number,
	input: (t: number) => number,
	_total: number,
): number[] {
	const pipe = pacedPipe()
	const block = new Float32Array(QUANTUM * 2)
	const sink = new Float32Array(QUANTUM * 2)
	const cpu: number[] = []
	let t = 0
	for (let b = 0; b < QUANTA; b++) {
		for (let i = 0; i < QUANTUM; i++, t++) block[2 * i] = block[2 * i + 1] = input(t)
		const t0 = performance.now()
		pipe.pitch = pipePitch(semitones, tempo)
		pipe.inputBuffer.putSamples(block, 0, QUANTUM)
		pipe.process()
		const k = Math.min(QUANTUM, pipe.outputBuffer.frameCount)
		pipe.outputBuffer.extract(sink, 0, k)
		pipe.outputBuffer.receive(k)
		cpu.push((performance.now() - t0) * 1000)
	}
	return cpu
}

function signalsmith(name: string, config: StretchConfig): Engine {
	return {
		name,
		async run(semitones, tempo, input) {
			// Live input ignores `rate`: the element plays raw at `tempo`, so the shift
			// also has to undo the record-style pitch change that causes.
			const s = await createStretch(config, semitones - 12 * Math.log2(tempo))
			const inL = new Float32Array(QUANTUM)
			const out = new Float32Array(QUANTA * QUANTUM)
			const cpu: number[] = []
			let t = 0
			for (let b = 0; b < QUANTA; b++) {
				for (let i = 0; i < QUANTUM; i++, t++) inL[i] = input(t)
				const t0 = performance.now()
				const [l] = s.process(inL, inL)
				cpu.push((performance.now() - t0) * 1000)
				out.set(l, b * QUANTUM)
			}
			return { out, cpu }
		},
	}
}

const ENGINES: Engine[] = [
	soundtouch,
	signalsmith('Signalsmith default', {}),
	signalsmith('Signalsmith cheaper', { preset: 'cheaper' }),
	signalsmith('Signalsmith 120 ms split', { blockMs: 120, intervalMs: 30, splitComputation: true }),
	signalsmith('Signalsmith 90 ms split', { blockMs: 90, intervalMs: 22.5, splitComputation: true }),
	signalsmith('Signalsmith 60 ms', { blockMs: 60, intervalMs: 15 }),
	signalsmith('Signalsmith 60 ms split', { blockMs: 60, intervalMs: 15, splitComputation: true }),
]

// --- signals --------------------------------------------------------------------

/** Harmonic partials of `f0` (1/k amplitudes) that stay well below Nyquist. */
function partials(f0: number, count: number): Array<[number, number]> {
	const out: Array<[number, number]> = []
	for (let k = 1; k <= count && k * f0 < SR * 0.4; k++) out.push([k * f0, 1 / k])
	return out
}

function synth(parts: Array<[number, number]>, gain: number) {
	return (t: number) => {
		let x = 0
		for (const [f, a] of parts) x += a * Math.sin((2 * Math.PI * f * t) / SR)
		return gain * x
	}
}

const TONE = (scale: number) => partials(196 * scale, 12)
const TRIAD = (scale: number) => [261.63, 329.63, 392].flatMap((f) => partials(f * scale, 8))

/** Clicks every 250 ms: an impulse plus a 5 ms decaying 1 kHz burst. */
function clicks(t: number): number {
	const period = SR / 4
	const p = t % period
	if (p === 0) return 0.6
	if (p > SR * 0.005) return 0
	return 0.4 * Math.exp(-p / (SR * 0.001)) * Math.sin((2 * Math.PI * 1000 * p) / SR)
}

/** Silence for 1 s, then a tone: for the onset latency. */
const onsetTone = (t: number) => (t < SR ? 0 : 0.3 * Math.sin((2 * Math.PI * 330 * t) / SR))

// --- metrics --------------------------------------------------------------------

function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1
		for (; j & bit; bit >>= 1) j ^= bit
		j ^= bit
		if (i < j) {
			;[re[i], re[j]] = [re[j]!, re[i]!]
			;[im[i], im[j]] = [im[j]!, im[i]!]
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len
		for (let i = 0; i < n; i += len) {
			for (let k = 0; k < len / 2; k++) {
				const wr = Math.cos(ang * k)
				const wi = Math.sin(ang * k)
				const a = i + k
				const b = a + len / 2
				const xr = re[b]! * wr - im[b]! * wi
				const xi = re[b]! * wi + im[b]! * wr
				re[b] = re[a]! - xr
				im[b] = im[a]! - xi
				re[a] = re[a]! + xr
				im[a] = im[a]! + xi
			}
		}
	}
}

/** Harmonic-to-residual ratio (dB) of `out` against the expected partials. */
function purity(out: Float32Array, expected: number[]): number {
	const N = 1 << 15
	const start = out.length - N // the settled tail
	const re = new Float64Array(N)
	const im = new Float64Array(N)
	for (let i = 0; i < N; i++)
		re[i] = out[start + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
	fft(re, im)
	const binHz = SR / N
	const near = new Uint8Array(N / 2)
	for (const f of expected) {
		const c = Math.round(f / binHz)
		for (let b = c - 4; b <= c + 4; b++) if (b > 0 && b < N / 2) near[b] = 1
	}
	let harm = 0
	let rest = 0
	for (let b = Math.ceil(20 / binHz); b < N / 2; b++) {
		const p = re[b]! ** 2 + im[b]! ** 2
		if (near[b]) harm += p
		else rest += p
	}
	return 10 * Math.log10(harm / rest)
}

/**
 * Share (%) of each click's energy outside [-3, +15] ms of its peak, over ±120 ms
 * — wide enough to catch a phase vocoder's pre-echo (up to a block ahead) and a
 * WSOLA splice repeating the click.
 */
function smear(out: Float32Array): number {
	const period = SR / 4
	const win = Math.round(SR * 0.12)
	let outside = 0
	let total = 0
	for (let c = 4; (c + 1) * period + win < out.length; c++) {
		// Search for the peak within the period (latency shifts it).
		let peak = c * period
		for (let i = c * period; i < (c + 1) * period; i++) {
			if (Math.abs(out[i]!) > Math.abs(out[peak]!)) peak = i
		}
		for (let i = peak - win; i < peak + win; i++) {
			const e = out[i]! ** 2
			total += e
			const dt = (i - peak) / SR
			if (dt < -0.003 || dt > 0.015) outside += e
		}
	}
	return (100 * outside) / total
}

function onsetMs(out: Float32Array): number {
	for (let i = SR; i < out.length; i++) if (Math.abs(out[i]!) > 0.03) return ((i - SR) / SR) * 1000
	return Number.NaN
}

function cpuStats(cpu: number[]) {
	const s = cpu.slice(Math.round(SR / QUANTUM)).sort((a, b) => a - b) // after 1 s warm-up
	const mean = s.reduce((a, b) => a + b, 0) / s.length
	return { mean, p99: s[Math.floor(s.length * 0.99)]!, max: s.at(-1)! }
}

// --- run ------------------------------------------------------------------------

const GRID: Array<[number, number]> = [
	[-12, 1],
	[-5, 1],
	[5, 1],
	[12, 1],
	[-5, 0.75],
	[5, 1.5],
	[12, 0.75],
]

// Slow (~15 s): run it on purpose with `bun run spike:compare`.
it.runIf(process.env.SPIKE_COMPARE)('compares the engines', { timeout: 600_000 }, async () => {
	// Warm both engines' JITs so the first grid cell isn't penalized.
	for (const e of ENGINES) await e.run(5, 1, synth(TONE(1), 0.3))

	const rows: string[] = []
	const agg = new Map<
		string,
		{
			lat: number[]
			tone: number[]
			triad: number[]
			smear: number[]
			mean: number[]
			p99: number[]
			max: number[]
		}
	>()
	for (const [st, tempo] of GRID) {
		const ratio = 2 ** (st / 12)
		for (const e of ENGINES) {
			const tone = await e.run(st, tempo, synth(TONE(tempo), 0.3))
			const triad = await e.run(st, tempo, synth(TRIAD(tempo), 0.15))
			const click = await e.run(st, tempo, clicks)
			const onset = await e.run(st, tempo, onsetTone)
			const r = {
				lat: onsetMs(onset.out),
				tone: purity(
					tone.out,
					TONE(ratio).map(([f]) => f),
				),
				triad: purity(
					triad.out,
					TRIAD(ratio).map(([f]) => f),
				),
				smear: smear(click.out),
				...cpuStats(tone.cpu),
			}
			const a = agg.get(e.name) ?? {
				lat: [],
				tone: [],
				triad: [],
				smear: [],
				mean: [],
				p99: [],
				max: [],
			}
			a.lat.push(r.lat)
			a.tone.push(r.tone)
			a.triad.push(r.triad)
			a.smear.push(r.smear)
			a.mean.push(r.mean)
			a.p99.push(r.p99)
			a.max.push(r.max)
			agg.set(e.name, a)
			rows.push(
				`| ${st > 0 ? '+' : ''}${st} st, ${tempo}× | ${e.name} | ${r.lat.toFixed(0)} | ${r.tone.toFixed(1)} | ${r.triad.toFixed(1)} | ${r.smear.toFixed(1)} | ${r.mean.toFixed(0)} / ${r.p99.toFixed(0)} / ${r.max.toFixed(0)} |`,
			)
		}
	}
	const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
	const summary = [...agg].map(
		([name, a]) =>
			`| ${name} | ${Math.min(...a.lat).toFixed(0)}–${Math.max(...a.lat).toFixed(0)} | ${avg(a.tone).toFixed(1)} | ${avg(a.triad).toFixed(1)} | ${avg(a.smear).toFixed(1)} | ${avg(a.mean).toFixed(0)} / ${avg(a.p99).toFixed(0)} / ${Math.max(...a.max).toFixed(0)} |`,
	)
	const header =
		'| engine | latency ms | tone purity dB | triad purity dB | click smear % | cpu µs mean / p99 / max |\n|---|---|---|---|---|---|'
	expect(rows).toHaveLength(GRID.length * ENGINES.length)
	writeFileSync(
		new URL('./RESULTS.md', import.meta.url),
		`# Signalsmith spike — offline A/B\n\nGenerated by \`spike/compare.test.ts\`. 48 kHz, 128-frame quanta, ${SECONDS} s per run. CPU is this machine under Node/V8, not a browser worklet; budget per quantum ≈ 2667 µs.\n\n## Summary (grid averages; latency range; cpu max is worst over grid)\n\n${header}\n${summary.join('\n')}\n\n## Per setting\n\n| setting | engine | latency ms | tone dB | triad dB | smear % | cpu µs mean / p99 / max |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`,
	)
})
