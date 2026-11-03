# SPDX-License-Identifier: MIT
"""CoworkOS-native neutral formula/mass wrapper around the fixed RDKit runtime.

The unchanged v4 parser supplies the same bounded molecular scope and guards.
This is not an extraction of SciAgentGYM's molecular-property/DBE function.
"""

import importlib.util
import inspect
import math
from pathlib import Path

VERSION = "sciagentgym-e9dbbea-mass-spec-v6"


class ScienceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _chemistry():
    # Fixed product sibling only; no module name or path comes from a request.
    spec = importlib.util.spec_from_file_location("atria_mass_chemistry_v4", Path(__file__).with_name("chemistry.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.VERSION != "atria-rdkit-chemistry-v4":
        raise ScienceError("runtime_mismatch", "The installed molecular parser does not match this catalog")
    return module


def rdkit_exact_mass_and_formula(smiles):
    parser = _chemistry()
    try:
        molecule, canonical, Chem = parser._molecule(smiles)
    except parser.ScienceError as error:
        raise ScienceError(error.code, str(error)) from None
    if Chem.GetFormalCharge(molecule) != 0:
        raise ScienceError("unsupported_molecule", "Neutral molecular mass requires zero net formal charge; no charged-ion or adduct mass is inferred")
    try:
        from rdkit.Chem import Descriptors, rdMolDescriptors
    except (ImportError, OSError):
        raise ScienceError("dependency_unavailable", "RDKit mass/formula modules are unavailable in the configured chemistry Python environment") from None
    try:
        mass = float(Descriptors.ExactMolWt(molecule))
        formula = rdMolDescriptors.CalcMolFormula(molecule, separateIsotopes=True, abbreviateHIsotopes=False)
    except (ValueError, RuntimeError, ArithmeticError):
        raise ScienceError("numeric_range", "RDKit could not calculate the selected molecular mass and formula") from None
    if not math.isfinite(mass) or mass <= 0 or not isinstance(formula, str) or not formula:
        raise ScienceError("numeric_range", "RDKit produced an unsupported mass or formula")
    return {"ok": True,
            "result": {"canonical_smiles": canonical, "formula": formula,
                       "exact_mass_da": mass, "rdkit_version": parser.RDKIT_VERSION},
            "units": {"canonical_smiles": "RDKit canonical isomeric SMILES", "formula": "isotope-labelled molecular formula",
                      "exact_mass_da": "Da", "rdkit_version": "version"},
            "assumptions": [
                "CoworkOS-native wrapper around rdkit==2026.9.1 (2026.09.1), using the unchanged v4 parser: one connected closed-shell molecule, at most 2048 ASCII SMILES characters and 256 input graph atoms including explicit hydrogen, using H/B/C/N/O/F/Si/P/S/Cl/Br/I. No names, whitespace, CXSMILES, atom maps, query/dummy atoms, salts or non-ordinary covalent bonds. Unknown isotope masses and oversized raw isotope/H/charge fields are rejected.",
                "ExactMolWt is the neutral molecular mass in dalton using each element's most abundant isotope for unspecified labels and tabulated masses for explicit isotopes. It is distinct from average MolWt, a measured mass, or a full isotope distribution. Zero net formal charge is required, while charge-separated representations may remain; no ionization, electron removal/addition, adduct, protonation state or ion m/z is inferred.",
                "CalcMolFormula uses separateIsotopes=True and abbreviateHIsotopes=False, preserving explicit labels such as [13C] and [2H]. Implicit hydrogens participate in formula and mass; the canonical SMILES and formula do not establish experimental identity. No DBE, fragmentation, structure ranking or molecular-ion assignment is returned."
            ]}


TOOLS = {"rdkit_exact_mass_and_formula": rdkit_exact_mass_and_formula}


def run(request):
    if not isinstance(request, dict) or set(request) != {"version", "tool", "arguments"}:
        raise ScienceError("invalid_request", "Expected only version, tool and arguments")
    if request["version"] != VERSION:
        raise ScienceError("version_mismatch", "The requested scientific catalog version is unavailable")
    name, arguments = request["tool"], request["arguments"]
    if not isinstance(name, str) or name not in TOOLS:
        raise ScienceError("unknown_tool", "The requested function is not in the mass chemistry catalog")
    if not isinstance(arguments, dict):
        raise ScienceError("invalid_arguments", "arguments must be an object")
    function = TOOLS[name]
    try:
        inspect.signature(function).bind(**arguments)
    except TypeError:
        raise ScienceError("invalid_arguments", "Arguments do not match the selected scientific function") from None
    return function(**arguments)
