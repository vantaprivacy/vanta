from setuptools import setup, find_packages

setup(
    name="vanta-sdk",
    version="0.1.0",
    description="Python SDK for VANTA Protocol — private intent execution on Solana",
    author="VANTA Protocol Contributors",
    url="https://github.com/vantaagent/vanta",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "solana>=0.30.0",
        "pynacl>=1.5.0",
        "cryptography>=41.0.0",
        "httpx>=0.25.0",
    ],
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: Apache Software License",
        "Programming Language :: Python :: 3",
    ],
)
