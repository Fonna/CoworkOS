# SPDX-License-Identifier: MIT
"""Explicit local environment check; no installation or tool discovery."""

from contextlib import redirect_stdout
import importlib
import json
import math
import sys

sys.dont_write_bytecode = True
packages = {}
with redirect_stdout(sys.stderr):
    for name in ("numpy", "scipy", "rdkit"):
        status = {"available": False}
        try:
            module = importlib.import_module(name)
            status = {"available": True, "version": str(getattr(module, "__version__", "unknown"))}
            if name == "rdkit":
                status["selfTestPassed"] = False
                from rdkit import Chem
                from rdkit.Chem import Descriptors
                molecule = Chem.MolFromSmiles("CCO")
                weight = float(Descriptors.MolWt(molecule))
                if molecule is None or not math.isfinite(weight) or abs(weight - 46.069) > 0.001:
                    raise ValueError("RDKit descriptor self-test failed")
                status["selfTestPassed"] = True
        except Exception:
            status["available"] = False
        packages[name] = status
sys.stdout.write(json.dumps({"python": {"available": True, "version": sys.version.split()[0]}, "packages": packages}, allow_nan=False, separators=(",", ":")) + "\n")
