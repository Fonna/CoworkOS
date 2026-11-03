# Optional scientific computation tools

[中文](../scientific-tools.md) | English

CoworkOS offers 40 offline scientific functions: 33 adapted from a pinned SciAgentGYM revision, four CoworkOS-native RDKit molecular tools, and three native statistics functions. Main and delegated agents use three fixed tools: `science_search`, `science_describe`, and `science_run`. New enabled Runs use the v7 catalog; existing v1–v6 Runs retain their original 12, 18, 26, 29, 33 and 37 functions respectively. Computation runs in a separate Python process while CoworkOS retains its existing model, agent loop, delegation and checkpoint mechanisms.

## Enable and use on demand

The feature is off by default. In Web/App, open Settings → Scientific computation → Manage scientific environments to enable it and select general Python and an optional separate RDKit Python. Startup environment variables are also supported:

```sh
COWORK_SCIENCE_TOOLS=1 COWORK_SCIENCE_PYTHON=/absolute/path/to/python3 atria
```

For a source checkout, replace `coworkos` with `npm start`. General Python defaults to the command `python3`; an absolute virtual-environment interpreter path is recommended. `COWORK_SCIENCE_CHEMISTRY_PYTHON` selects separate RDKit Python and inherits general Python when omitted. Saved fields are `science.enabled`, `science.pythonExecutable` and `science.chemistryPythonExecutable`. Environment variables override individual fields, which become locked in the UI.

Twenty-eight functions require Python 3.9+ and no third-party Python packages, including three mass-spectrum/isotope functions. The other eight array-analysis/statistics and four RDKit tools use optional dependencies in their selected environments. Ordinary Main startup does not discover Python automatically. Scientific initialization, settings reads/saves, search and describe only read metadata and never start Python or install/download dependencies.

Main can select `enable_tools({groups:["science"]})`, discover a function, inspect its contract and execute it when the task requires calculation. The user can simply request a scientific task; there is no additional confirmation for each calculation. Delegates of an enabled session receive the same three tools with their own working directories. Ordinary sessions gain no scientific schemas, skill roots or base-prompt instructions.

Source, CLI and App share configuration and execution; settings manage environments without adding a scientific editor. Path changes apply to new tasks. Enablement changes apply when a subsequent session process starts; running sessions do not change immediately. Existing tasks retain their catalog and environment selection. Resuming an old science task after disabling keeps its schemas but returns unavailable for calculations.

The general and RDKit check buttons explicitly start isolated Python to inspect the current unsaved path, dependency versions and a minimal RDKit example without saving drafts. Results distinguish unavailable interpreters, missing dependencies and incompatible versions, with manual installation guidance. Missing array dependencies leave standard-library scalar calculations usable; RDKit failures leave general science and ordinary agent tools available.

New enabled Runs receive concise scientific capability and task descriptions. `science_search` recognizes bilingual task phrasing and synonyms such as “去背景后找峰”, “standard curve”, and “dimensionality reduction”. Ranking reads only the pinned catalog. Inspect matches with `science_describe` for units, assumptions, and limits.

Two opt-in workflow skills, `scientific-analysis` and `molecular-analysis`, guide multi-step tasks. Main and delegates first see metadata, then use `load_skill` when relevant; simple conversions need no skill. Guidance covers data inspection, calculation selection, verification, and reproducible deliverables. Ordinary disabled scopes gain no skill roots. Scripts must explicitly use the Run's selected interpreter: an arbitrary `python` command does not adopt scientific settings. `science_run` continues to accept only reviewed names and JSON arguments.

## Install and reuse separate environments

Use the installation buttons in scientific settings to create separate venvs from the selected host Python, download fixed-version wheels from PyPI, and verify versions and representative calculations. The page supports progress phases, cancellation, and retry. Closing settings leaves installation running; application shutdown reclaims its processes. Use environment fills only the draft; Save settings selects it for subsequent tasks. Installation never enables science or changes existing Runs.

The CLI shares the installer and `ATRIA_HOME` storage:

```sh
coworkos science status
coworkos science install general --python /absolute/path/to/python3
coworkos science install chemistry --python /absolute/path/to/python3
coworkos science cancel general
coworkos science install general --python /absolute/path/to/python3 --reinstall
```

`status` runs no Python or network request. Installation reports an interpreter path for settings or scientific environment variables. Repeated installation with the same specification and source interpreter reuses the published environment. Reinstall creates a new generation and publishes it after checks. Failure, cancellation, and interruption preserve prior ready environments and existing pinned interpreters. Completed venvs are never moved; published older generations currently have no automatic garbage collection.

Environments live under `science-environments/` in CoworkOS's data root, separate from the App, projects, and system Python. General dependencies are NumPy 2.2.6 / SciPy 1.15.3; molecular dependencies are RDKit 2026.9.1 / NumPy 2.2.6 / Pillow 11.3.0. Installation accepts no arbitrary packages or pip arguments, and inherits no model credentials, user pip configuration, or proxies.

The first installer requires existing Python 3.10+, `venv` / `ensurepip`, and access to PyPI; it does not download Python itself. Matching fixed-version wheels must exist for the selected Python, architecture, and platform. Missing wheels fail installation instead of compiling source or modifying system packages. The pinned RDKit release has no Intel Mac wheel. Install host Python first when unavailable; external environments and manual installation remain supported.

## Available functions

| Capability           | Functions                                                       | Units and assumptions                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Photon conversion    | `eV_to_nm`, `nm_to_eV`                                          | eV and nm; photons in vacuum                                                                                                                                                        |
| Ideal gas            | `ideal_gas_state`, `isothermal_process`, `isobaric_process`     | Scalar Pa, m³, mol, K; ideal gas                                                                                                                                                    |
| Phase equilibrium    | `clausius_clapeyron_temperature`, `clausius_clapeyron_pressure` | Pa, K, J/mol; constant positive vaporization/sublimation enthalpy and ideal vapor                                                                                                   |
| Acoustic pressure    | `convert_spl_to_pressure`, `convert_pressure_to_spl`            | RMS pressure, 20 μPa reference; Pa and dB                                                                                                                                           |
| Sound addition       | `add_two_spl_values`                                            | Uncorrelated sources with a shared reference; exact logarithmic addition; `use_table` can only be false                                                                             |
| Distance attenuation | `calculate_spl_at_distance`                                     | Free-field point source and positive distances; only `environment=free_field`                                                                                                       |
| Spectrum peaks       | `analyze_spectrum`                                              | Equal-length finite arrays with at least 3 samples; strictly increasing positive wavelengths and nonnegative intensity with a positive maximum; 8192 samples and 1024 peaks maximum |

The v2 catalog also includes:

| Capability          | Function                | Input and assumptions                                                                                                                                                                     |
| ------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline correction | `baseline_correction`   | Global polynomial detrending only, degree 0–5; uniformly spaced sample indices and more points than degree; broad real peaks can be removed                                               |
| Raw signal peaks    | `peak_detection`        | Absolute height thresholds and original heights; optional increasing coordinates; widths are in sample points at half prominence, not general FWHM                                        |
| Linear calibration  | `fit_calibration_curve` | At least 3 paired samples; unweighted ordinary least squares with an intercept; returns `[slope, intercept]`, residuals, fits and optional predictions; R² is null for constant responses |
| Standardized PCA    | `multivariate_analysis` | Rows are samples and columns are features; 2–512 rows, 1–64 columns, at most 8192 cells; population-standard-deviation scaling; components at most min(samples−1, features)               |
| Nernst potential    | `nernst_potential`      | Reduction half-reaction Ox + n e⁻ → Red; positive dimensionless activities, integer electron count, K and V; result shares E0's reference electrode                                       |
| Bragg spacing       | `bragg_law_d_spacing`   | First-order diffraction; input 2θ in degrees strictly between 0° and 180°; wavelength and result in Å, default wavelength 1.5406 Å                                                        |

One-dimensional arrays contain at most 8192 samples, with at most 1024 detected peaks. Polynomial detrending fits sample indices and does not identify a physical background. PCA signs use a positive largest absolute loading; tied eigenspaces have no unique basis and do not establish causality or chemical mechanisms. Calibration returns neither Python callables nor detection limits unsupported by blank/noise validation.

PCA subtracts each column's first value before centering the offsets to preserve small changes on a large common baseline. Reuse standardization as `((x - centering_origin) - centering_offset) / scales`, then multiply by the loading transpose. `means` is a potentially rounded summary in original feature units.

Nernst uses `E = E0 + (RT/nF) ln(a_oxidized/a_reduced)`, correcting the selected upstream sign to the stated reduction convention. See [IUPAC Nernst equation](https://goldbook.iupac.org/terms/view/09068). Activities cannot be substituted with concentrations without a stated approximation.

The v3 catalog adds these astronomy functions. All use the standard library without Astropy, Astroquery or catalog services:

| Capability                  | Function                       | Input and assumptions                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual extinction           | `calculate_extinction`         | `e_bv` is 0–5 mag; `rv` is 0.1–10, default 3.1; returns `A_V = rv × e_bv` in mag                                                                                                                                                      |
| True distance modulus       | `calculate_distance_modulus`   | `m_obs`, `M_abs` and `a_v` use the same photometric band; default extinction 0; returns `m_obs − M_abs − a_v`                                                                                                                         |
| Modulus to distance         | `distance_from_modulus`        | `mu` is already extinction-corrected, −10–30 mag; returns pc, spanning 0.1–10⁷ pc; no cosmological corrections                                                                                                                        |
| Stellar luminosity          | `calculate_stellar_luminosity` | `radius` uses solar radii; `radius_unit` is fixed to `solar`; effective temperature 2000–50000 K; spherical bolometric luminosity                                                                                                     |
| Transit light and depth     | `calculate_transit_depth`      | Both radii use solar radii and planet radius cannot exceed stellar radius; light uses a shared distance, band (or both bolometric) and solar-luminosity scale; uniform brightness, full overlap, dark planet and unocculted companion |
| Small-shift radial velocity | `wavelength_shift_to_velocity` | `delta_lambda` and `lambda_0` use Å, with `abs(delta_lambda/lambda_0) ≤ 0.001`; first-order Doppler approximation, result m/s, positive for recession                                                                                 |
| Kepler period               | `kepler_third_law`             | Semimajor axis `a` in m and dominant stellar mass `M_star` in kg; result s; Newtonian weak-field orbit with negligible companion mass                                                                                                 |
| Binary mass ratio           | `calculate_mass_ratio_from_rv` | `k1` and `k2` are positive fitted radial-velocity semi-amplitudes of the same double-lined binary in km/s; explicitly returns `m1/m2 = k2/k1`                                                                                         |

Stellar luminosity returns an object containing solar luminosity, watts, converted radius and temperature. Transit returns `remaining_luminosity` in solar luminosities together with `transit_depth_fraction`, `transit_depth_percent`, blocked area fraction, light lost and total luminosity before transit. Remaining light must not be interpreted as depth. The transit model includes no limb darkening, grazing geometry, impact parameter or time-dependent light curve.

Doppler results include no relativistic, gravitational, cosmological or barycentric correction and are unsuitable for precision radial-velocity work. Kepler does not check collision, stellar size or relativistic validity; numeric acceptance does not establish astrophysical feasibility. The mass ratio is the inverse of the common `q = m2/m1` convention, so component numbering must be checked.

Solar nominal conversions and the gravitational constant follow the [IAU 2015 resolutions](https://iauarchive.eso.org/static/resolutions/IAU2015_English.pdf) and [NIST](https://www.nist.gov/how-do-you-measure-it/how-do-you-measure-strength-gravity); the undiluted transit area-ratio definition is documented by [NASA HEASARC](https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/exoplanodb.html).

The v4 catalog adds three CoworkOS-native RDKit wrappers. Their provenance is `atria-native`; they are not extracted SciAgentGYM functions:

| Capability                     | Function                      | Input and result                                                                                                                                 |
| ------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| SMILES validation              | `rdkit_validate_smiles`       | Parse/sanitize and return `valid: true`, canonical SMILES, graph atom/heavy-atom counts, formal charge and version; invalid inputs return errors |
| Canonical SMILES serialization | `rdkit_canonicalize_smiles`   | Return RDKit canonical isomeric SMILES and version, retaining supported isotope and supplied stereochemical information                          |
| 2D molecular descriptors       | `rdkit_molecular_descriptors` | Require zero net formal charge; return MolWt (g/mol), Wildman–Crippen logP, Lipinski HBD/HBA and N/O-only TPSA (Å²)                              |

Each accepts only a `smiles` string of 1–2048 ASCII characters without whitespace and at most 256 input graph atoms, including explicit hydrogen. The scope is one connected closed-shell molecule containing H, B, C, N, O, F, Si, P, S, Cl, Br or I. Isotope labels must have a mass recorded in RDKit's isotope table. Raw bracket hydrogen counts and per-atom charge magnitudes must not exceed 8; numeric and repeated-sign charge forms are checked before parsing to avoid integer truncation. Salts/mixtures, atom maps, query/dummy atoms, radicals and non-covalent extensions are rejected. Returned `atom_count` follows ordinary explicit-H removal, excludes implicit H and retains isotope-labelled H.

Successful validation means RDKit parsed/sanitized a structure within this scope. Canonical SMILES depends on toolkit/version and is not a universal chemical identity; no protonation-state selection, tautomer standardization, salt removal or neutralization is performed. Descriptors allow zero-net-charge separated-charge representations. MolWt is not monoisotopic ExactMolWt, logP is a structural estimate rather than a measured value or pH-dependent logD, and TPSA is not a 3D surface area. See the [RDKit Book](https://www.rdkit.org/docs/RDKit_Book.html) and [Crippen documentation](https://www.rdkit.org/docs/source/rdkit.Chem.Crippen.html).

The v5 catalog adds four materials functions using only the standard library in general Python:

| Capability               | Function                                | Input and assumptions                                                                                                                                          |
| ------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cubic lattice parameter  | `cubic_lattice_parameter`               | `d_spacing` in Å and three integer `hkl` values, not all zero; `a = d × sqrt(h²+k²+l²)` in Å; cubic systems only                                               |
| Direct lattice metric    | `calculate_metric_tensor`               | `a,b,c` in Å and `alpha,beta,gamma` in degrees; returns `metric_tensor` (3×3, Å²) and `volume_angstrom3` (Å³); requires a nondegenerate positive-definite cell |
| General plane spacing    | `calculate_interplanar_spacing_general` | Integer `h,k,l`, not all zero, and a symmetric positive-definite 3×3 direct `metric_tensor` in Å²; returns Å; reciprocal metric has no 2π factor               |
| Scherrer domain estimate | `calculate_scherrer_grain_size`         | Peak position and FWHM use degrees on the 2θ axis; wavelength in nm, default 0.15406; shape factor default 0.9; size result in nm                              |

Cell lengths and `d_spacing` have numeric bounds of 10⁻⁶–10⁶ Å. Miller indices are integers from −1000 to 1000 and cannot all be zero; common factors are not reduced. Angles span 0.001°–179.999°. Direct metrics are exactly symmetric 3×3 matrices with absolute entries at most 10¹² Å² and diagonal entries at least 10⁻¹² Å². Cholesky and conditioning checks reject invalid or nearly degenerate inputs, including infinity-norm condition numbers above 10¹⁰. These arithmetic budgets do not establish a physically existing material.

The cell angles `alpha`, `beta` and `gamma` lie between b/c, a/c and a/b respectively. Each angle being between 0° and 180° does not guarantee a valid cell: together they must produce a positive-definite metric. Lattice geometry does not index diffraction peaks, determine systematic absences, identify phases or solve crystal structures.

Scherrer uses `D = K × wavelength_nm / (beta_rad × cos(theta))`, where `theta = peak_2theta_deg / 2`. Its wavelength and size use nm, whereas Bragg and lattice geometry use Å: `1 nm = 10 Å`. This version explicitly assumes Gaussian broadening: `beta_rad = sqrt(fwhm_deg² − instrument_fwhm_deg²) × pi/180`, with measured FWHM greater than nonnegative instrumental FWHM, replacing the upstream subtraction without a stated profile model. This is not Lorentzian/Voigt deconvolution and does not separate strain, defects or other broadening. The result estimates a coherent diffraction-domain size along the reflection direction, rather than directly measuring particles or grains. The general peak tools' half-prominence widths in sample points cannot be used directly as angular FWHM on the 2θ axis.

Scherrer budgets are 0.001°–179.999° for peak position, 10⁻⁶–10° for measured FWHM, 10⁻⁶–100 nm for wavelength and 0.1–2 for shape factor. A corrected-to-observed variance ratio at or below 10⁻¹² is rejected as nearly cancelling. The result object contains `D_nm`, `theta_deg`, `beta_rad`, `corrected_fwhm_deg` and fixed `instrument_model: "gaussian"`.

See [IUCr reciprocal-lattice teaching material](https://www.iucr.org/what-we-do/education/pamphlets/reciprocal-lattice) for metric conventions and the [IUCr Scherrer discussion](https://journals.iucr.org/j/issues/2024/05/00/oc5037/index.html) for size-broadening limits. A cubic cell with `a=b=c=4 Å` and all angles 90° gives a diagonal metric of 16 Å²; general spacing for `(h,k,l)=(2,0,0)` is `d=2 Å`, and converting that spacing with `hkl:[2,0,0]` recovers `a=4 Å`.

The v6 catalog adds these mass-spectrometry tools, retaining the existing general and RDKit Python settings:

| Capability                     | Function                                | Input and result                                                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mass-spectrum filtering        | `parse_mass_spectrum_peaks`             | Strictly increasing positive `mz_values` and equal-length nonnegative `intensities`; normalize the base peak to 100 before inclusive `intensity_threshold` filtering (default 1); return raw/relative intensities, base peak and highest retained m/z peak |
| Cl/C nominal isotope pattern   | `calculate_theoretical_isotope_pattern` | True integer `num_chlorine:0–16` and `num_carbon:0–128` (default 0); return probability and base-100 relative intensity separately for each nominal mass-shift bin                                                                                         |
| Known-charge candidate cluster | `find_isotope_cluster`                  | `peak_mz`, `peak_intensity` and `base_mz`; known `abs_charge:1–10` (default 1), `mass_tolerance` default 0.05 m/z; locate candidate M/M+2/+4/+6 relationships at nominal intervals                                                                         |
| Exact mass and formula         | `rdkit_exact_mass_and_formula`          | CoworkOS-native wrapper accepting bounded `smiles` with zero net formal charge; return `canonical_smiles`, isotope-preserving `formula`, `exact_mass_da` and `rdkit_version`                                                                               |

Inputs must already be centroided peak lists; these tools do not detect peaks or centroid continuous profiles. Peak inputs contain 1–8192 points, m/z and `base_mz` within 10⁻¹⁰⁰–10⁶, and raw intensities at most 10¹⁰⁰ with a positive maximum. Filtering more than 1024 retained peaks returns `result_too_large` without truncation. Relative intensity is a percentage of the original maximum, not a probability. `highest_mz_peak` identifies only the highest retained m/z; neither it nor the base peak establishes a molecular ion or molecular identity.

The isotope model convolves independent binomial ³⁷Cl and ¹³C counts into nominal bins `j + 2k`, where j counts ¹³C and k counts ³⁷Cl. All bins from 0 through `num_carbon + 2 × num_chlorine` are returned, including zero probabilities, at most 161. `probability` is distinct from `relative_intensity`, which normalizes the largest bin to 100. Fixed `p(³⁷Cl)=0.2424` and `p(¹³C)=0.0107` are recorded with the result; see [NIST chlorine](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=Cl) and [carbon](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=C). This Cl/C-only nominal mass-number model excludes other elements' isotopes, exact isotope mass differences and high-resolution fine structure. Natural abundances vary with samples; see [CIAAW chlorine](https://ciaaw.org/chlorine.htm) and [carbon](https://www.ciaaw.org/carbon.htm).

Cluster inputs require strictly increasing m/z and tolerance 10⁻⁶–0.25 m/z, smaller than `0.5/abs_charge`. After locating M near `base_mz`, subsequent targets are anchored to the observed M with nominal `2/abs_charge` spacing. Multiple candidates in any window return `ambiguous_match`. Results retain the requested anchor, observed M, matches/deviations, missing labels and charge parameters. Missing M, missing M+2 or zero M intensity gives a null ratio. Matches do not establish a common isotope origin. The tool does not infer chlorine count, charge, molecular ions or structure, or perform high-resolution exact-mass matching.

The native exact-mass tool uses the same pinned `rdkit==2026.9.1` environment and existing single-molecule restrictions, without changing older tools. It returns RDKit `ExactMolWt` in Da for the supplied zero-net-charge structure, rather than average MolWt, and performs no automatic ion, adduct or experimental m/z calculation. Unlabelled atoms follow RDKit's most-abundant-isotope convention; explicit isotope labels are retained. See [ExactMolWt](https://www.rdkit.org/docs/source/rdkit.Chem.Descriptors.html#rdkit.Chem.Descriptors.ExactMolWt) and [CalcMolFormula](https://www.rdkit.org/docs/source/rdkit.Chem.rdMolDescriptors.html#rdkit.Chem.rdMolDescriptors.CalcMolFormula).

The v7 catalog adds three CoworkOS-native statistics functions, reusing the general NumPy/SciPy environment without new dependencies:

| Capability              | Function                 | Contract                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numerical summary       | `summarize_numeric_data` | 1–8192 finite numbers; mean, median, linearly interpolated quartiles, sample variance and standard deviation; one observation gives null variance/standard deviation with an explanation                                                  |
| Linear association      | `pearson_correlation`    | Equal-length paired arrays, each with 3–8192 observations; r and an analytic two-sided p-value for zero population correlation; constant and near-constant data are rejected                                                              |
| Independent group means | `welch_t_test`           | Two independent samples in a common unit, each with 3–8192 observations and positive resolvable variance; mean difference A−B, Welch t, degrees of freedom, two-sided p-value and a fixed 95% confidence interval for the mean difference |

Inputs reject booleans, missing values, NaN and infinity, with absolute values at most 10¹⁰⁰; there is no automatic deletion or test selection. Quartiles use Hyndman–Fan type 7 and sample variance uses `ddof=1`; see [NumPy quantile](https://numpy.org/doc/2.2/reference/generated/numpy.quantile.html). Offset/scale arithmetic reduces large-offset and small-scale errors; unrepresentable nonzero results return `numeric_range`. For `|r| ≥ 1−10⁻¹²`, Pearson accepts only affine linearity provable from the exact input numbers; other inputs return `numeric_range`. Zero p-values outside exact linearity are also rejected to avoid misclassifying rounding as probability underflow. Extreme Welch p-values that underflow to zero carry an explicit flag and explanation.

Inferential calculations require independent observations. Pearson's analytic p-value has normal-model assumptions under the zero-correlation null; reliable small-sample Welch inference requires approximately normal populations. Arrays cannot establish these assumptions. Paired data, repeated measurements and time series must not be treated as independent groups. Tools make no automatic significance decision: correlation does not establish causation, and a p-value is neither the probability that the null is true nor an effect size. See [SciPy Pearson](https://docs.scipy.org/doc/scipy-1.15.3/reference/generated/scipy.stats.pearsonr.html) and [Welch t test](https://docs.scipy.org/doc/scipy-1.15.3/reference/generated/scipy.stats.ttest_ind.html).

Use `science_describe` for the exact schema, units, defaults, assumptions, example and provenance before execution. Additional parameters, expressions, module paths and execution options are rejected. Spectrum intensity is normalized to its maximum. Widths use sample points and are null when not computed. Peak detection does not perform baseline correction, chemical identification or physical interpretation.

For example, `science_run` with `{"name":"eV_to_nm","arguments":{"energy_eV":2}}` returns approximately 619.92 nm, together with units, assumptions and provenance.

## Experimental-data example

Use existing `read` tools for user files, pass bounded arrays into science, and use ordinary file tools to save results. For example, call `science_run` with:

```json
{
  "name": "fit_calibration_curve",
  "arguments": {
    "concentrations": [0, 1, 2, 3],
    "responses": [1, 3, 5, 7],
    "predict_at": [1.5]
  }
}
```

The result has a slope of approximately 2, intercept 1 and predicted response 4, together with fit and uncertainty information. Science accepts JSON arrays and returns numbers; file access and chart creation continue through the agent's existing capabilities.

An astronomy task can also chain calls: `calculate_extinction({e_bv:0.2})` gives `A_V = 0.62 mag`; `calculate_distance_modulus({m_obs:10.62,M_abs:5,a_v:0.62})` then gives `mu = 5 mag`; `distance_from_modulus({mu:5})` gives `100 pc`. Put each argument object inside `science_run.arguments`. The user or existing measurements must supply matching-band magnitudes and the extinction assumptions.

## Optional numeric dependencies

Baseline correction, linear calibration and PCA require NumPy. `analyze_spectrum` and `peak_detection` require NumPy and SciPy. PCA adds no pandas or scikit-learn dependency. In a separate Python 3.10+ virtual environment, install the verified versions:

```sh
python3 -m venv .tools/science
.tools/science/bin/python -m pip install numpy==2.2.6 scipy==1.15.3
COWORK_SCIENCE_TOOLS=1 COWORK_SCIENCE_PYTHON="$PWD/.tools/science/bin/python" npm start
```

This source-checkout example is never run automatically. The dependency list is copied to `dist/src/tools/science/requirements.txt`. Missing optional libraries fail only the corresponding array analysis; scalar calculations and ordinary agent tools remain available. Scientific dependencies are not bundled with the App; explicitly install them through settings or the CLI installer, or supply your own environment. CAD/Blender runtimes in the Mac package remain managed by their components. Scientific tools use the interpreter selected by `COWORK_SCIENCE_PYTHON`, or `python3` when omitted.

Use a separate Python 3.10+ RDKit environment to avoid changing the array environment. The v4 lock is `rdkit==2026.9.1` (runtime version `2026.09.1`), `numpy==2.2.6` and `Pillow==11.3.0`; see [requirements-chemistry.txt](../../src/tools/science/requirements-chemistry.txt):

```sh
python3 -m venv .tools/science-rdkit
.tools/science-rdkit/bin/python -m pip install rdkit==2026.9.1 numpy==2.2.6 Pillow==11.3.0
```

Select its absolute interpreter path in RDKit settings or `COWORK_SCIENCE_CHEMISTRY_PYTHON`. On Windows use the environment's `Scripts/python.exe`. This RDKit release has macOS arm64, Linux and Windows wheels, but no Intel Mac wheel; other RDKit versions return `dependency_version_mismatch` without silent fallback. See [PyPI 2026.9.1 files](https://pypi.org/project/rdkit/2026.9.1/). For example, `science_run({name:"rdkit_canonicalize_smiles",arguments:{smiles:"OCC"}})` returns `CCO`; molecular descriptors for `CCO` give MolWt approximately 46.069 g/mol.

## Execution and recovery

Each execution owns a fresh process group and exclusive working directory. It uses a minimal environment and `-I`, without inherited model credentials, proxies or user Python paths. Upstream code is never imported into the agent process. Only reviewed functions in the selected offline catalog execute; the upstream agent, directory scanner, network queries and arbitrary Python code are excluded.

Input and output are each limited to 1 MiB, and execution defaults to 30 seconds. Functions enforce numeric and size bounds. Cancellation, timeout, excess output and errors terminate the relevant process group and return `isError` without closing the agent. Process separation does not establish a general OS sandbox for CoworkOS or its bash/jobs tools.

An enabled Run records its catalog version and general/chemistry interpreters in `science-tools.json`; environment or settings path changes do not silently replace that selection. Delegation queues persist the selection as well. Disabling science on restart retains a previously enabled Run's fixed schemas for replay but makes execution unavailable; new disabled Runs expose no science tools. Invalid or unsupported records are preserved and disable only science.

Seven catalogs are supported: `sciagentgym-e9dbbea-pilot-v1` (12 functions), `sciagentgym-e9dbbea-analysis-v2` (18), `sciagentgym-e9dbbea-astronomy-v3` (26), `atria-rdkit-chemistry-v4` (29), `sciagentgym-e9dbbea-materials-v5` (33), `sciagentgym-e9dbbea-mass-spec-v6` (37), and `atria-statistics-v7` (40). The v1–v6 parameters, descriptions and Python implementations remain unchanged; older catalogs cannot discover or execute later additions. Dashboard manual retries inherit the original selection even when assigned a new Run ID. Requests that originally had no science capability retain that scope. Conflicting or unreadable inheritance records preserve the original request and reject that launch rather than changing its execution environment.

The functions perform repeatable offline computations. They provide neither persistent long jobs nor exactly-once execution across process crashes. Existing request retry and checkpoints remain in use; expensive, external and network computations require separate lifecycle work.

## Source and extension points

Thirty-three adapted functions are pinned to [SciAgentGYM e9dbbea](https://github.com/CMarsRover/SciAgentGYM/tree/e9dbbea4369d67694e38bf8be67bedbcaf9e9300). Adaptations remove plotting, file writes and import side effects and add validation, units, stable arithmetic and JSON results. Catalog metadata contains the upstream file hash and line. [LICENSE](../../vendor/sciagentgym/LICENSE) and [NOTICE](../../vendor/sciagentgym/NOTICE) record licensing and modifications. Four RDKit wrappers and three statistics functions are native CoworkOS implementations whose provenance contains the local implementation path, implementation version and corresponding library documentation, separately from upstream extraction records.

Implementation: [versioned catalog](../../src/tools/science/catalog.ts), [astronomy metadata](../../src/tools/science/astronomy-catalog.ts), [molecular metadata](../../src/tools/science/chemistry-catalog.ts), [statistics metadata](../../src/tools/science/statistics-catalog.ts), [service](../../src/tools/science/service.ts), [tools](../../src/tools/science-tools.ts), [Run configuration](../../src/runtime/science-config.ts), [environment settings/checks](../../src/runtime/science-environment.ts), [settings controller](../../web/assets/controllers/science-settings.js), [Main wrapper](../../.pi/runtime/tools/science.ts), [Python runner](../../src/tools/science/runner.py). Behavior checks cover [original kernels](../../test/science-kernels.test.js), [experimental analysis](../../test/science-analysis.test.js), [astronomy](../../test/science-astronomy.test.js), [RDKit](../../test/science-chemistry.test.js), [statistics](../../test/science-statistics.test.js), [service](../../test/science-tools.test.js), [configuration](../../test/science-config.test.js), [real Pi](../../test/science-pi.test.js), [Dashboard retries/data workflow](../../test/science-main-retry.test.js) and [settings browser workflows](../../e2e/science-settings.spec.js).

Add a specific function only after known-answer, units and failure checks. Keep new dependencies optional and verify that disabled ordinary sessions retain their tool schemas, base prompts and skill catalogs.
