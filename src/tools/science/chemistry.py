# SPDX-License-Identifier: MIT
"""CoworkOS-native bounded RDKit wrappers, not SciAgentGYM function adaptations.

The upstream partition-coefficient tools informed the descriptor selection only.
No upstream module or arbitrary user code is imported, and no files are written.
"""

import inspect
import math
import re

VERSION = "atria-rdkit-chemistry-v4"
RDKIT_VERSION = "2026.09.1"
MAX_SMILES_LENGTH = 2048
MAX_ATOMS = 256
ALLOWED_ELEMENTS = frozenset((1, 5, 6, 7, 8, 9, 14, 15, 16, 17, 35, 53))


class ScienceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _rdkit():
    try:
        import rdkit
        from rdkit import Chem, rdBase
    except (ImportError, OSError):
        raise ScienceError("dependency_unavailable", "RDKit is unavailable in the configured chemistry Python environment") from None
    if getattr(rdkit, "__version__", None) != RDKIT_VERSION:
        raise ScienceError("dependency_version_mismatch", "This chemistry catalog requires rdkit==2026.9.1")
    return Chem, rdBase


def _smiles_text(smiles):
    if not isinstance(smiles, str) or not 1 <= len(smiles) <= MAX_SMILES_LENGTH:
        raise ScienceError("invalid_arguments", "smiles must be a string of 1 to 2048 ASCII characters")
    if any(ord(character) < 33 or ord(character) > 126 for character in smiles) or "|" in smiles:
        raise ScienceError("invalid_arguments", "smiles must contain one ASCII molecular SMILES without whitespace, a name or CXSMILES annotations")
    # RDKit's isotope field wraps at 16 bits; reject raw oversized labels before parsing.
    if any(int(label) > 65535 for label in re.findall(r"\[([0-9]+)", smiles)):
        raise ScienceError("unsupported_molecule", "Isotope labels exceed the supported parser range")
    # The parser also narrows explicit H counts and atom charge fields. Check the
    # raw bracket values so large numbers/repeated signs cannot turn into methane.
    hydrogen_counts = re.findall(r"\[(?:[0-9]+)?(?:[A-Z][a-z]?|[bcnops]|se|as|\*|#[0-9]+)(?:@(?:TH|AL|SP|TB|OH)[0-9]*|@@?)?H([0-9]+)", smiles)
    if any(int(count) > 8 for count in hydrogen_counts):
        raise ScienceError("unsupported_molecule", "Explicit bracket hydrogen counts must not exceed 8 per atom")
    for bracket in re.findall(r"\[([^\]]*)\]", smiles):
        charge_magnitude = sum(int(count) if count else 1 for count in re.findall(r"[+-]([0-9]*)", bracket))
        if charge_magnitude > 8:
            raise ScienceError("unsupported_molecule", "Explicit per-atom charge magnitude must not exceed 8")
    return smiles


def _molecule(smiles):
    text = _smiles_text(smiles)
    Chem, rdBase = _rdkit()
    parameters = Chem.SmilesParserParams()
    parameters.sanitize = True
    parameters.removeHs = False
    parameters.parseName = False
    parameters.allowCXSMILES = False
    # Invalid user structures should produce a compact error, not a parser dump.
    with rdBase.BlockLogs():
        try:
            molecule = Chem.MolFromSmiles(text, parameters)
        except (ValueError, RuntimeError):
            molecule = None
    if molecule is None or molecule.GetNumAtoms() == 0:
        raise ScienceError("invalid_smiles", "RDKit could not parse and sanitize the supplied molecular SMILES")
    if molecule.GetNumAtoms() > MAX_ATOMS:
        raise ScienceError("unsupported_molecule", "The input molecule exceeds the 256-atom budget, including explicit hydrogen atoms")
    if len(Chem.GetMolFrags(molecule)) != 1:
        raise ScienceError("unsupported_molecule", "Only a single connected molecule is supported; salts and mixtures must be supplied as separate species")
    for atom in molecule.GetAtoms():
        if atom.HasQuery() or atom.GetAtomicNum() not in ALLOWED_ELEMENTS:
            raise ScienceError("unsupported_molecule", "Only non-query atoms H, B, C, N, O, F, Si, P, S, Cl, Br and I are supported")
        isotope = atom.GetIsotope()
        if isotope and Chem.GetPeriodicTable().GetMassForIsotope(atom.GetAtomicNum(), isotope) <= 0:
            raise ScienceError("unsupported_molecule", "Isotope labels must have tabulated RDKit isotope masses; mass-number fallback is not supported")
        if atom.HasProp("molAtomMapNumber"):
            raise ScienceError("unsupported_molecule", "Atom-mapped structures are outside this chemistry catalog")
        if atom.GetNumRadicalElectrons():
            raise ScienceError("unsupported_molecule", "Radical species are outside this closed-shell chemistry catalog")
    supported_bonds = (Chem.BondType.SINGLE, Chem.BondType.DOUBLE, Chem.BondType.TRIPLE, Chem.BondType.AROMATIC)
    if any(bond.HasQuery() or bond.GetBondType() not in supported_bonds for bond in molecule.GetBonds()):
        raise ScienceError("unsupported_molecule", "Only ordinary single, double, triple and aromatic covalent bonds are supported")
    # Match normal SMILES parsing, while applying the atom budget before H removal.
    with rdBase.BlockLogs():
        try:
            molecule = Chem.RemoveHs(molecule, sanitize=True)
            canonical = Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True, doRandom=False)
        except (ValueError, RuntimeError):
            raise ScienceError("invalid_smiles", "RDKit could not produce a sanitized canonical molecular SMILES") from None
    return molecule, canonical, Chem


def _result(value, units, *assumptions):
    if any(isinstance(member, float) and not math.isfinite(member) for member in value.values()):
        raise ScienceError("numeric_range", "RDKit produced an unrepresentable descriptor")
    return {"ok": True, "result": value, "units": units, "assumptions": list(assumptions)}


def rdkit_validate_smiles(smiles):
    molecule, canonical, Chem = _molecule(smiles)
    return _result({"valid": True, "canonical_smiles": canonical,
                    "atom_count": molecule.GetNumAtoms(), "heavy_atom_count": molecule.GetNumHeavyAtoms(),
                    "formal_charge": Chem.GetFormalCharge(molecule), "rdkit_version": RDKIT_VERSION},
                   {"valid": "boolean", "canonical_smiles": "RDKit canonical isomeric SMILES",
                    "atom_count": "count", "heavy_atom_count": "count", "formal_charge": "elementary charge", "rdkit_version": "version"},
                   "CoworkOS-native wrapper around pinned RDKit, informed by upstream descriptor use. valid=true means RDKit parsed and sanitized a structure within this pilot's scope; it does not establish experimental existence, stability, identity or complete stereochemical correctness. Invalid SMILES return invalid_smiles; valid structures outside the bounded scope return unsupported_molecule.",
                   "One connected closed-shell molecule, at most 256 input graph atoms including explicit hydrogen, using H, B, C, N, O, F, Si, P, S, Cl, Br or I. Isotope labels must have tabulated RDKit masses; unknown-isotope mass-number fallback is rejected. Raw explicit bracket H counts and per-atom charge magnitudes are limited to 8 to prevent parser integer truncation. No names, whitespace, CXSMILES, atom maps, query/dummy atoms or non-covalent bond extensions. Charged single species can be validated. Returned atom_count counts the RDKit graph after ordinary explicit-H removal, excluding implicit hydrogens; isotope-labelled hydrogen is retained.")


def rdkit_canonicalize_smiles(smiles):
    _, canonical, _ = _molecule(smiles)
    return _result({"canonical_smiles": canonical, "rdkit_version": RDKIT_VERSION},
                   {"canonical_smiles": "RDKit canonical isomeric SMILES", "rdkit_version": "version"},
                   "CoworkOS-native canonical isomeric SMILES serialization using rdkit==2026.9.1 with ordinary explicit-H removal and RDKit sanitization/aromaticity perception. RDKit-supported stereochemical and isotope information is retained; unspecified stereochemistry is not enumerated or inferred. Canonical SMILES is toolkit/version dependent, not a universal chemical identifier.",
                   "The same bounded single-molecule scope as rdkit_validate_smiles applies. No tautomer standardization, protonation-state selection, charge neutralization, salt removal or experimental identity inference is performed.")


def rdkit_molecular_descriptors(smiles):
    molecule, canonical, Chem = _molecule(smiles)
    if Chem.GetFormalCharge(molecule) != 0:
        raise ScienceError("unsupported_molecule", "This descriptor pilot requires zero net formal charge; it does not neutralize charged species")
    try:
        from rdkit.Chem import Crippen, Descriptors, Lipinski, rdMolDescriptors
    except (ImportError, OSError):
        raise ScienceError("dependency_unavailable", "RDKit descriptor modules are unavailable in the configured chemistry Python environment") from None
    try:
        values = {"canonical_smiles": canonical, "molecular_weight": float(Descriptors.MolWt(molecule)),
                  "logp_crippen": float(Crippen.MolLogP(molecule)),
                  "hydrogen_bond_donors": int(Lipinski.NumHDonors(molecule)),
                  "hydrogen_bond_acceptors": int(Lipinski.NumHAcceptors(molecule)),
                  "tpsa": float(rdMolDescriptors.CalcTPSA(molecule, includeSandP=False)), "rdkit_version": RDKIT_VERSION}
    except (ValueError, RuntimeError, ArithmeticError):
        raise ScienceError("numeric_range", "RDKit could not calculate the selected molecular descriptors") from None
    return _result(values,
                   {"canonical_smiles": "RDKit canonical isomeric SMILES", "molecular_weight": "g/mol",
                    "logp_crippen": "dimensionless (log10)", "hydrogen_bond_donors": "count",
                    "hydrogen_bond_acceptors": "count", "tpsa": "angstrom^2", "rdkit_version": "version"},
                   "CoworkOS-native 2D descriptors from rdkit==2026.9.1, informed by SciAgentGYM's RDKit descriptor selection. MolWt uses average atomic weights for unspecified isotopes and tabulated masses for isotope labels; it is not ExactMolWt or a monoisotopic mass.",
                   "logp_crippen is the Wildman-Crippen atomic-contribution estimate of octanol/water logP for the supplied structure, not an experimental partition coefficient, pH-dependent logD, solubility, permeability, safety or drug-efficacy prediction. Zero net formal charge is required but charge-separated representations may remain; no protonation/tautomer state is inferred.",
                   "HBD/HBA follow RDKit Lipinski definitions. TPSA is the topological Ertl polar surface descriptor in square angstrom; includeSandP=False preserves RDKit's default N/O contributions and excludes sulfur/phosphorus contributions. These are graph descriptors, not a 3D surface-area calculation. The bounded closed-shell single-molecule scope of rdkit_validate_smiles applies.")


TOOLS = {function.__name__: function for function in (rdkit_validate_smiles, rdkit_canonicalize_smiles, rdkit_molecular_descriptors)}


def run(request):
    if not isinstance(request, dict) or set(request) != {"version", "tool", "arguments"}:
        raise ScienceError("invalid_request", "Expected only version, tool and arguments")
    if request["version"] != VERSION:
        raise ScienceError("version_mismatch", "The requested scientific catalog version is unavailable")
    name, arguments = request["tool"], request["arguments"]
    if not isinstance(name, str) or name not in TOOLS:
        raise ScienceError("unknown_tool", "The requested function is not in the chemistry catalog")
    if not isinstance(arguments, dict):
        raise ScienceError("invalid_arguments", "arguments must be an object")
    function = TOOLS[name]
    try:
        inspect.signature(function).bind(**arguments)
    except TypeError:
        raise ScienceError("invalid_arguments", "Arguments do not match the selected scientific function") from None
    return function(**arguments)
